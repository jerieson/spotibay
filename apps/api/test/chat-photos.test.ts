import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ChatPhotoUploadResponse, RoomResponse } from '@spotibay/shared';
import { eq } from 'drizzle-orm';
import { adminAuditLog, chatPhotos } from '../src/db/schema.js';
import { CHAT_PHOTO_TTL_MS } from '../src/services/photos.js';
import { createHarness, joinRoom, next, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.redis.flushdb();
  await h.settings.set('features.chat', true, null);
  await h.settings.set('features.chatPhotos', true, null);
  await h.settings.set('limits.chatPhotosPerMinute', 5, null);
  await h.settings.set('limits.chatMessagesPerMinute', 20, null);
  h.photoClock.offsetMs = 0;
});

/** A real picture: a PNG with GPS metadata, so stripping it can be checked. */
const png = () =>
  sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#7c3aed' } })
    .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '14/1 35/1 0/1' } })
    .png()
    .toBuffer();

type Guest = Awaited<ReturnType<Harness['guest']>>;

async function upload(g: Guest, code: string, body: Buffer, type = 'image/png') {
  const res = await fetch(`${h.baseUrl}/api/rooms/${code}/photos`, {
    method: 'POST',
    headers: { cookie: g.cookie, 'content-type': type },
    body: new Uint8Array(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as ChatPhotoUploadResponse & { error?: string },
  };
}

async function photo(g: Guest, id: string) {
  return fetch(`${h.baseUrl}/api/photos/${id}`, { headers: { cookie: g.cookie } });
}

async function setup() {
  const host = await h.guest();
  const code = (await host.api<RoomResponse>('POST', '/rooms', { name: 'Photo room' })).body.room
    .code;
  const hostSocket = await host.socket();
  await joinRoom(hostSocket, code);
  const friend = await h.guest();
  const friendSocket = await friend.socket();
  await joinRoom(friendSocket, code);
  return { host, hostSocket, friend, friendSocket, code };
}

const isPhoto = (m: ChatMessage) => m.kind === 'user' && m.media?.kind === 'photo';

describe('chat photos', () => {
  it('re-encodes an upload to a small WebP without metadata and sends it in chat', async () => {
    const { friend, friendSocket, hostSocket, code } = await setup();
    const up = await upload(friend, code, await png());
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ width: 1600, height: 800 });

    const res = await photo(friend, up.body.id);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();

    const atHost = next(hostSocket, 'chat:message', isPhoto);
    friendSocket.emit('chat:send', { body: 'look', media: { kind: 'photo', id: up.body.id } });
    const message = await atHost;
    expect(message.kind === 'user' && message.media).toMatchObject({
      kind: 'photo',
      url: `/api/photos/${up.body.id}`,
      width: 1600,
      height: 800,
    });
  });

  it("refuses files that aren't pictures, people outside the room, and too many uploads", async () => {
    const { friend, code } = await setup();
    const fake = await upload(friend, code, Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml');
    expect(fake.status).toBe(422);

    const stranger = await h.guest();
    expect((await upload(stranger, code, await png())).status).toBe(403);

    // Refused uploads count too (they cost the server the same work), so start the minute afresh.
    await h.redis.del(`ratelimit:photos:${friend.user.id}`);
    await h.settings.set('limits.chatPhotosPerMinute', 1, null);
    expect((await upload(friend, code, await png())).status).toBe(201);
    expect((await upload(friend, code, await png())).status).toBe(429);

    await h.settings.set('features.chatPhotos', false, null);
    expect((await upload(friend, code, await png())).status).toBe(403);
  });

  it("won't send someone else's photo, or the same photo twice", async () => {
    const { host, friendSocket, hostSocket, code } = await setup();
    const mine = await upload(host, code, await png());
    const err = next(friendSocket, 'error');
    friendSocket.emit('chat:send', { body: '', media: { kind: 'photo', id: mine.body.id } });
    expect((await err).code).toBe('invalid_payload');

    const sent = next(hostSocket, 'chat:message', isPhoto);
    hostSocket.emit('chat:send', { body: '', media: { kind: 'photo', id: mine.body.id } });
    await sent;
    const again = next(hostSocket, 'error');
    hostSocket.emit('chat:send', { body: '', media: { kind: 'photo', id: mine.body.id } });
    expect((await again).code).toBe('invalid_payload');
  });

  it('lets the host take a photo down, but not a listener', async () => {
    const { friend, friendSocket, hostSocket, code } = await setup();
    const up = await upload(friend, code, await png());
    const sent = next(hostSocket, 'chat:message', isPhoto);
    friendSocket.emit('chat:send', { body: '', media: { kind: 'photo', id: up.body.id } });
    const message = await sent;

    const refused = next(friendSocket, 'error');
    friendSocket.emit('chat:deletePhoto', { messageId: message.id });
    expect((await refused).code).toBe('forbidden');

    const gone = next(friendSocket, 'chat:deleted');
    hostSocket.emit('chat:deletePhoto', { messageId: message.id });
    expect((await gone).id).toBe(message.id);
    expect((await photo(friend, up.body.id)).status).toBe(404);
  });

  it('deletes the photos when the room closes, and after a day', async () => {
    const first = await setup();
    const kept = await upload(first.friend, first.code, await png());
    first.friendSocket.emit('chat:send', { body: '', media: { kind: 'photo', id: kept.body.id } });
    await next(first.hostSocket, 'chat:message', isPhoto);

    const closed = next(first.friendSocket, 'room:closed');
    await first.host.api('POST', `/rooms/${first.code}/close`);
    await closed;
    await expect.poll(async () => (await photo(first.friend, kept.body.id)).status).toBe(404);

    const second = await setup();
    const old = await upload(second.friend, second.code, await png());
    second.friendSocket.emit('chat:send', { body: '', media: { kind: 'photo', id: old.body.id } });
    await next(second.hostSocket, 'chat:message', isPhoto);
    h.photoClock.offsetMs = CHAT_PHOTO_TTL_MS + 1000;
    expect((await photo(second.friend, old.body.id)).status).toBe(404);
    expect(await h.photos.sweep()).toBeGreaterThan(0);
    expect(await h.db.select().from(chatPhotos).where(eq(chatPhotos.id, old.body.id))).toEqual([]);
  });

  it('lets the admin see and purge photos, recorded in the audit log', async () => {
    const { friend, friendSocket, hostSocket, code } = await setup();
    const up = await upload(friend, code, await png());
    friendSocket.emit('chat:send', { body: '', media: { kind: 'photo', id: up.body.id } });
    const message = await next(hostSocket, 'chat:message', isPhoto);

    const admin = await h.admin();
    const seen = await fetch(`${h.baseUrl}/api/admin/photos/${up.body.id}`, {
      headers: { cookie: admin.cookie },
    });
    expect(seen.status).toBe(200);

    const gone = next(hostSocket, 'chat:deleted');
    const purged = await admin.api<{ messages: number; photos: number }>('POST', '/photos/purge', {
      roomCode: code,
    });
    expect(purged.body).toEqual({ messages: 1, photos: 1 });
    expect((await gone).id).toBe(message.id);
    expect((await photo(friend, up.body.id)).status).toBe(404);
    const [entry] = await h.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.action, 'chat.purgePhotos'));
    expect(entry).toMatchObject({ targetType: 'room', targetId: code });
  });
});
