import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RoomListResponse, RoomResponse } from '@spotibay/shared';
import { createHarness, joinRoom, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.settings.set('features.guestRoomCreation', true, null);
  await h.settings.set('features.publicRooms', true, null);
  await h.settings.set('limits.maxActiveRooms', 50, null);
});

describe('rooms REST', () => {
  it('requires a session', async () => {
    const res = await fetch(`${h.baseUrl}/api/rooms`);
    expect(res.status).toBe(401);
  });

  it('creates a room with a 6-character code and the creator as host', async () => {
    const host = await h.guest();
    const res = await host.api<RoomResponse>('POST', '/rooms', { name: '  Friday vibes  ' });
    expect(res.status).toBe(201);
    expect(res.body.room).toMatchObject({
      name: 'Friday vibes',
      visibility: 'public',
      hasPassword: false,
      hostId: host.user.id,
      memberCount: 0,
      nowPlaying: null,
    });
    expect(res.body.room.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it('rejects invalid bodies', async () => {
    const host = await h.guest();
    expect((await host.api('POST', '/rooms', { name: '' })).status).toBe(400);
    expect((await host.api('POST', '/rooms', { name: 'x'.repeat(41) })).status).toBe(400);
    // a password only makes sense on a private room
    expect((await host.api('POST', '/rooms', { name: 'x', password: 'secret' })).status).toBe(400);
    expect((await host.api('POST', '/rooms', { name: 'x', visibility: 'secret' })).status).toBe(
      400,
    );
  });

  it('respects features.guestRoomCreation, features.publicRooms and limits.maxActiveRooms', async () => {
    const host = await h.guest();

    await h.settings.set('features.guestRoomCreation', false, null);
    expect((await host.api('POST', '/rooms', { name: 'a' })).status).toBe(403);
    await h.settings.set('features.guestRoomCreation', true, null);

    await h.settings.set('features.publicRooms', false, null);
    expect((await host.api('POST', '/rooms', { name: 'a' })).status).toBe(403);
    expect((await host.api('POST', '/rooms', { name: 'a', visibility: 'private' })).status).toBe(
      201,
    );
    expect((await host.api<RoomListResponse>('GET', '/rooms')).body.rooms).toEqual([]);
    await h.settings.set('features.publicRooms', true, null);

    const open = (await h.rooms.listOpen()).length;
    await h.settings.set('limits.maxActiveRooms', open, null);
    expect((await host.api('POST', '/rooms', { name: 'one too many' })).status).toBe(429);
  });

  it('lists only public rooms, with member counts', async () => {
    const host = await h.guest();
    const pub = (await host.api<RoomResponse>('POST', '/rooms', { name: 'Public one' })).body.room;
    const priv = (
      await host.api<RoomResponse>('POST', '/rooms', { name: 'Hidden', visibility: 'private' })
    ).body.room;

    const socket = await host.socket();
    await joinRoom(socket, pub.code);

    const list = (await host.api<RoomListResponse>('GET', '/rooms')).body.rooms;
    const codes = list.map((r) => r.code);
    expect(codes).toContain(pub.code);
    expect(codes).not.toContain(priv.code);
    expect(list.find((r) => r.code === pub.code)?.memberCount).toBe(1);
  });

  it('fetches a room by code (case-insensitive) and 404s for unknown or malformed codes', async () => {
    const host = await h.guest();
    const room = (await host.api<RoomResponse>('POST', '/rooms', { name: 'Findable' })).body.room;
    const other = await h.guest();
    const found = await other.api<RoomResponse>('GET', `/rooms/${room.code.toLowerCase()}`);
    expect(found.status).toBe(200);
    expect(found.body.room.name).toBe('Findable');
    expect((await other.api('GET', '/rooms/ZZZZZZ')).status).toBe(404);
    expect((await other.api('GET', '/rooms/nope')).status).toBe(404);
  });

  it('lets only the host update a room, and manages passwords', async () => {
    const host = await h.guest();
    const other = await h.guest();
    const room = (await host.api<RoomResponse>('POST', '/rooms', { name: 'Before' })).body.room;

    expect((await other.api('PATCH', `/rooms/${room.code}`, { name: 'Hijack' })).status).toBe(403);
    expect((await host.api('PATCH', `/rooms/${room.code}`, {})).status).toBe(400);

    const renamed = await host.api<RoomResponse>('PATCH', `/rooms/${room.code}`, { name: 'After' });
    expect(renamed.body.room.name).toBe('After');

    // a password on a public room is refused; going private first works
    expect((await host.api('PATCH', `/rooms/${room.code}`, { password: 'letmein' })).status).toBe(
      400,
    );
    const priv = await host.api<RoomResponse>('PATCH', `/rooms/${room.code}`, {
      visibility: 'private',
      password: 'letmein',
    });
    expect(priv.body.room).toMatchObject({ visibility: 'private', hasPassword: true });

    const cleared = await host.api<RoomResponse>('PATCH', `/rooms/${room.code}`, {
      password: null,
    });
    expect(cleared.body.room.hasPassword).toBe(false);

    // going public drops any password
    await host.api('PATCH', `/rooms/${room.code}`, { password: 'again1' });
    const pub = await host.api<RoomResponse>('PATCH', `/rooms/${room.code}`, {
      visibility: 'public',
    });
    expect(pub.body.room).toMatchObject({ visibility: 'public', hasPassword: false });
  });

  it('lets only the host close a room, after which it is gone', async () => {
    const host = await h.guest();
    const other = await h.guest();
    const room = (await host.api<RoomResponse>('POST', '/rooms', { name: 'Closing' })).body.room;

    expect((await other.api('POST', `/rooms/${room.code}/close`)).status).toBe(403);
    expect((await host.api('POST', `/rooms/${room.code}/close`)).status).toBe(204);
    expect((await host.api('GET', `/rooms/${room.code}`)).status).toBe(410);
    expect((await host.api('POST', `/rooms/${room.code}/close`)).status).toBe(410);
    const list = (await host.api<RoomListResponse>('GET', '/rooms')).body.rooms;
    expect(list.map((r) => r.code)).not.toContain(room.code);
  });
});
