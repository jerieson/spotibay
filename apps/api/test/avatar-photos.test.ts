import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@spotibay/shared';
import { eq } from 'drizzle-orm';
import { adminAuditLog } from '../src/db/schema.js';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.redis.flushdb();
});

type Guest = Awaited<ReturnType<Harness['guest']>>;

const picture = (color: string) =>
  sharp({ create: { width: 900, height: 600, channels: 3, background: color } })
    .jpeg()
    .toBuffer();

async function setPhoto(g: Guest, body: Buffer, type = 'image/jpeg') {
  const res = await fetch(`${h.baseUrl}/api/me/avatar-photo`, {
    method: 'PUT',
    headers: { cookie: g.cookie, 'content-type': type },
    body: new Uint8Array(body),
  });
  return { status: res.status, body: (await res.json()) as { user: User; error?: string } };
}

const avatar = (g: Guest, id: string) =>
  fetch(`${h.baseUrl}/api/avatars/${id}`, { headers: { cookie: g.cookie } });

describe('photo avatars', () => {
  it('turns an upload into a 256 px square and puts it on the profile', async () => {
    const g = await h.guest();
    const res = await setPhoto(g, await picture('#2f8cff'));
    expect(res.status).toBe(200);
    const { photoId } = res.body.user.avatar;
    expect(photoId).toBeDefined();
    expect((await g.api<{ user: User }>('GET', '/me')).body.user.avatar.photoId).toBe(photoId);

    const served = await avatar(g, photoId!);
    expect(served.headers.get('cache-control')).toContain('immutable');
    const meta = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 256, height: 256 });
  });

  it('replaces the old photo, keeps it when the generated avatar is edited, and removes it', async () => {
    const g = await h.guest();
    const first = (await setPhoto(g, await picture('#ff0000'))).body.user.avatar.photoId!;
    const second = (await setPhoto(g, await picture('#00ff00'))).body.user.avatar.photoId!;
    expect(second).not.toBe(first);
    expect((await avatar(g, first)).status).toBe(404);

    // Someone can't point their avatar at another photo, and a style change keeps theirs.
    const patched = await g.api<{ user: User }>('PATCH', '/me', {
      avatar: { ...g.user.avatar, style: 'bottts', photoId: first },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.user.avatar).toMatchObject({ style: 'bottts', photoId: second });

    const cleared = await g.api<{ user: User }>('DELETE', '/me/avatar-photo');
    expect(cleared.body.user.avatar.photoId).toBeUndefined();
    expect(cleared.body.user.avatar.style).toBe('bottts');
    expect((await avatar(g, second)).status).toBe(404);
  });

  it("refuses files that aren't pictures", async () => {
    const g = await h.guest();
    expect((await setPhoto(g, Buffer.from('not a picture'), 'image/png')).status).toBe(422);
  });

  it('lets the admin take a photo down, recorded in the audit log', async () => {
    const g = await h.guest();
    const photoId = (await setPhoto(g, await picture('#7c3aed'))).body.user.avatar.photoId!;
    const admin = await h.admin();
    expect((await admin.api('DELETE', `/users/${g.user.id}/avatar-photo`)).status).toBe(204);
    expect((await avatar(g, photoId)).status).toBe(404);
    expect((await g.api<{ user: User }>('GET', '/me')).body.user.avatar.photoId).toBeUndefined();
    const [entry] = await h.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.action, 'user.removeAvatarPhoto'));
    expect(entry).toMatchObject({ targetType: 'user', targetId: g.user.id });
  });
});
