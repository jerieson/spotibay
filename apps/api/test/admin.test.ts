import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  AdminBan,
  AdminQuotaResponse,
  AdminRoomDetail,
  AdminRoomSummary,
  AdminStats,
  AdminUserDetail,
  AdminChatMessage,
  AuditListResponse,
  RoomResponse,
} from '@spotibay/shared';
import {
  ADMIN_USERNAME,
  connected,
  createHarness,
  joinRoom,
  next,
  sleep,
  type Harness,
} from './helpers/harness.js';

let h: Harness;
let ipCounter = 10;
const freshIp = () => `198.51.100.${ipCounter++}`;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.settings.set('site.maintenanceMode', false, null);
  await h.settings.set('site.announcement', null, null);
  await h.settings.set('limits.maxUsersPerRoom', 30, null);
});

async function openRoom(
  host: Awaited<ReturnType<Harness['guest']>>,
  body: object = { name: 'Lounge' },
) {
  const res = await host.api<RoomResponse>('POST', '/rooms', body);
  return res.body.room.code;
}

async function auditActions(admin: Awaited<ReturnType<Harness['admin']>>, action?: string) {
  const query = action ? `?action=${action}` : '';
  const res = await admin.api<AuditListResponse>('GET', `/audit${query}`);
  return res.body.entries;
}

describe('admin auth', () => {
  it('refuses requests without an admin session', async () => {
    const guest = await h.guest();
    expect((await fetch(`${h.baseUrl}/api/admin/settings`)).status).toBe(401);
    // A guest session is not an admin session.
    const res = await fetch(`${h.baseUrl}/api/admin/settings`, {
      headers: { cookie: guest.cookie },
    });
    expect(res.status).toBe(401);
  });

  it('logs in, identifies the admin and logs out', async () => {
    const admin = await h.admin(freshIp());
    expect(
      (await admin.api<{ admin: { username: string } }>('GET', '/me')).body.admin.username,
    ).toBe(ADMIN_USERNAME);
    const out = await fetch(`${h.baseUrl}/api/admin/logout`, { method: 'POST' });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()[0]).toContain('spotibay_admin=;');
  });

  it('rejects wrong credentials without telling which part was wrong', async () => {
    const ip = freshIp();
    const login = (username: string, password: string) =>
      fetch(`${h.baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ username, password }),
      });
    const wrongPassword = await login(ADMIN_USERNAME, 'nope');
    const wrongUser = await login('someone', h.adminPassword);
    expect(wrongPassword.status).toBe(401);
    expect(wrongUser.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await wrongUser.json());
  });

  it('allows 5 login attempts per 15 minutes per IP', async () => {
    const ip = freshIp();
    const attempt = () =>
      fetch(`${h.baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ username: ADMIN_USERNAME, password: 'wrong' }),
      });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
    // Even the right password is refused while limited, and other addresses are unaffected.
    const limited = await fetch(`${h.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: h.adminPassword }),
    });
    expect(limited.status).toBe(429);
    await h.admin(freshIp());
  });

  it('validates the login body', async () => {
    const res = await fetch(`${h.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      body: JSON.stringify({ username: '' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('admin settings', () => {
  it('applies changes live and records them in the audit log', async () => {
    const admin = await h.admin(freshIp());
    const host = await h.guest();
    const code = await openRoom(host);
    const hostSocket = await host.socket();
    expect((await joinRoom(hostSocket, code)).ack.ok).toBe(true);

    const put = await admin.api('PUT', '/settings/limits.maxUsersPerRoom', { value: 1 });
    expect(put.status).toBe(200);
    expect(h.settings.get('limits.maxUsersPerRoom')).toBe(1);

    const guest = await h.guest();
    const { ack } = await joinRoom(await guest.socket(), code);
    expect(ack.ok ? null : ack.error.code).toBe('room_full');

    const entries = await auditActions(admin, 'settings.update');
    expect(entries[0]).toMatchObject({
      adminUsername: ADMIN_USERNAME,
      targetType: 'setting',
      targetId: 'limits.maxUsersPerRoom',
      details: { from: 30, to: 1 },
    });
  });

  it('lists current values', async () => {
    const admin = await h.admin(freshIp());
    const res = await admin.api<{ settings: Record<string, unknown> }>('GET', '/settings');
    expect(res.status).toBe(200);
    expect(res.body.settings['limits.maxUsersPerRoom']).toBe(30);
    expect(res.body.settings['features.chat']).toBe(true);
  });

  it('rejects invalid values and unknown keys', async () => {
    const admin = await h.admin(freshIp());
    expect((await admin.api('PUT', '/settings/limits.maxUsersPerRoom', { value: -3 })).status).toBe(
      400,
    );
    expect(
      (await admin.api('PUT', '/settings/limits.maxUsersPerRoom', { value: 'many' })).status,
    ).toBe(400);
    expect((await admin.api('PUT', '/settings/queue.skipVoteThreshold', { value: 0 })).status).toBe(
      400,
    );
    expect((await admin.api('PUT', '/settings/nope.nothing', { value: 1 })).status).toBe(404);
    expect(h.settings.get('limits.maxUsersPerRoom')).toBe(30);
  });

  it('broadcasts public settings to connected clients and keeps others private', async () => {
    const admin = await h.admin(freshIp());
    const guest = await h.guest();
    const socket = await guest.socket();
    const seen: string[] = [];
    socket.on('settings:updated', (u) => seen.push(u.key));

    const update = next(socket, 'settings:updated', (u) => u.key === 'features.chat');
    await admin.api('PUT', '/settings/limits.maxQueueLength', { value: 100 });
    await admin.api('PUT', '/settings/features.chat', { value: false });
    expect(await update).toMatchObject({ key: 'features.chat', value: false });
    expect(seen).not.toContain('limits.maxQueueLength');
    await admin.api('PUT', '/settings/features.chat', { value: true });
    await admin.api('PUT', '/settings/limits.maxQueueLength', { value: 200 });
  });
});

describe('admin rooms', () => {
  it('lists open rooms with members and queue length, and shows one in detail', async () => {
    const admin = await h.admin(freshIp());
    const host = await h.guest();
    const code = await openRoom(host, { name: 'Detail room' });
    expect((await joinRoom(await host.socket(), code)).ack.ok).toBe(true);

    const list = await admin.api<{ rooms: AdminRoomSummary[] }>('GET', '/rooms');
    const summary = list.body.rooms.find((r) => r.code === code);
    expect(summary).toMatchObject({
      name: 'Detail room',
      memberCount: 1,
      queueLength: 0,
      hostId: host.user.id,
      hostName: host.user.displayName,
    });

    const detail = await admin.api<{ room: AdminRoomDetail }>('GET', `/rooms/${code}`);
    expect(detail.body.room.members.map((m) => m.userId)).toEqual([host.user.id]);
    expect((await admin.api('GET', '/rooms/ZZZZZZ')).status).toBe(404);
    expect((await admin.api('GET', '/rooms/bad')).status).toBe(404);
  });

  it('closes a room, tells its members and logs it', async () => {
    const admin = await h.admin(freshIp());
    const host = await h.guest();
    const code = await openRoom(host);
    const socket = await host.socket();
    await joinRoom(socket, code);

    const closed = next(socket, 'room:closed');
    expect((await admin.api('POST', `/rooms/${code}/close`)).status).toBe(204);
    expect(await closed).toEqual({ reason: 'admin' });
    expect((await admin.api('POST', `/rooms/${code}/close`)).status).toBe(404);
    expect((await host.api('GET', `/rooms/${code}`)).status).toBe(410);

    const [entry] = await auditActions(admin, 'room.close');
    expect(entry).toMatchObject({ targetType: 'room', targetId: code });
  });

  it('lets the admin join any room as host, skipping the password', async () => {
    const admin = await h.admin(freshIp());
    const host = await h.guest();
    const code = await openRoom(host, {
      name: 'Secret',
      visibility: 'private',
      password: 'hunter22',
    });
    await joinRoom(await host.socket(), code);

    const visitor = await h.guest();
    const socket = h.connect(`${visitor.cookie}; ${admin.cookie}`);
    await connected(socket);
    const denied = await joinRoom(socket, code);
    expect(denied.ack.ok ? null : denied.ack.error.code).toBe('wrong_password');

    const { ack, state } = await joinRoomAsAdmin(socket, code);
    expect(ack.ok).toBe(true);
    expect(state?.you.role).toBe('host');

    const [entry] = await auditActions(admin, 'room.join_override');
    expect(entry).toMatchObject({ targetType: 'room', targetId: code });
  });

  it('ignores asAdmin from a socket without an admin session', async () => {
    const host = await h.guest();
    const code = await openRoom(host, {
      name: 'Secret',
      visibility: 'private',
      password: 'hunter22',
    });
    const visitor = await h.guest();
    const socket = await visitor.socket();
    const { ack } = await joinRoomAsAdmin(socket, code);
    expect(ack.ok ? null : ack.error.code).toBe('forbidden');
  });
});

function joinRoomAsAdmin(socket: Parameters<typeof joinRoom>[0], code: string) {
  const state = next(socket, 'room:state', () => true, 1500).catch(() => undefined);
  return new Promise<Awaited<ReturnType<typeof joinRoom>>>((resolve) => {
    socket.emit('room:join', { code, asAdmin: true }, async (ack) => {
      resolve({ ack, state: ack.ok ? await state : undefined });
    });
  });
}

describe('admin users, kicks and bans', () => {
  it('searches users by name', async () => {
    const admin = await h.admin(freshIp());
    const guest = await h.guest();
    const part = guest.user.displayName.slice(1, 6);
    const res = await admin.api<{ users: { id: string }[] }>(
      'GET',
      `/users?q=${encodeURIComponent(part)}`,
    );
    expect(res.body.users.map((u) => u.id)).toContain(guest.user.id);
    const none = await admin.api<{ users: unknown[] }>('GET', '/users?q=zzzz-no-such-name-zzzz');
    expect(none.body.users).toEqual([]);
    // LIKE wildcards in the query are literal.
    const wildcard = await admin.api<{ users: unknown[] }>('GET', '/users?q=%25');
    expect(wildcard.body.users).toEqual([]);
  });

  it('shows a user with their rooms and live addresses', async () => {
    const admin = await h.admin(freshIp());
    const host = await h.guest();
    const code = await openRoom(host);
    await joinRoom(await host.socket(), code);
    const res = await admin.api<{ user: AdminUserDetail }>('GET', `/users/${host.user.id}`);
    expect(res.body.user.rooms.map((r) => r.code)).toEqual([code]);
    expect(res.body.user.ips.length).toBe(1);
    expect(res.body.user.banned).toBe(false);
    expect((await admin.api('GET', '/users/not-a-uuid')).status).toBe(404);
  });

  it('kicks a user from a room', async () => {
    const admin = await h.admin(freshIp());
    const host = await h.guest();
    const code = await openRoom(host);
    const hostSocket = await host.socket();
    await joinRoom(hostSocket, code);
    const guest = await h.guest();
    const guestSocket = await guest.socket();
    await joinRoom(guestSocket, code);

    const kicked = next(guestSocket, 'user:kicked');
    const members = next(hostSocket, 'room:members', (m) => m.members.length === 1);
    expect((await admin.api('POST', `/rooms/${code}/kick`, { userId: guest.user.id })).status).toBe(
      204,
    );
    expect(await kicked).toEqual({ reason: 'kicked' });
    expect((await members).members[0]!.userId).toBe(host.user.id);
    // Not a ban: they can come back.
    expect((await joinRoom(guestSocket, code)).ack.ok).toBe(true);
    expect((await admin.api('POST', `/rooms/${code}/kick`, { userId: host.user.id })).status).toBe(
      204,
    );
    expect(
      (await admin.api('POST', `/rooms/${code}/kick`, { userId: crypto.randomUUID() })).status,
    ).toBe(404);

    const entries = await auditActions(admin, 'user.kick');
    expect(entries[1]).toMatchObject({ targetType: 'user', targetId: guest.user.id });
  });

  it('bans a user, cuts their connection, refuses them and lifts the ban', async () => {
    const admin = await h.admin(freshIp());
    const guest = await h.guest();
    const socket = await guest.socket();
    const kicked = next(socket, 'user:kicked');
    const disconnected = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));

    const created = await admin.api<{ ban: AdminBan }>('POST', '/bans', {
      type: 'user',
      value: guest.user.id,
      reason: 'spam',
      durationMinutes: 60,
    });
    expect(created.status).toBe(201);
    expect(created.body.ban).toMatchObject({
      type: 'user',
      userName: guest.user.displayName,
      reason: 'spam',
      active: true,
    });
    expect(await kicked).toEqual({ reason: 'banned' });
    await disconnected;

    const blocked = await guest.api('GET', '/me');
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ error: 'banned', reason: 'spam' });
    await expect(connected(h.connect(guest.cookie))).rejects.toThrow('banned');

    const listed = await admin.api<{ bans: AdminBan[] }>('GET', '/bans');
    expect(listed.body.bans.map((b) => b.id)).toContain(created.body.ban.id);

    const lifted = await admin.api<{ ban: AdminBan }>('DELETE', `/bans/${created.body.ban.id}`);
    expect(lifted.status).toBe(200);
    expect(lifted.body.ban.active).toBe(false);
    expect((await guest.api('GET', '/me')).status).toBe(200);
    expect((await admin.api('DELETE', `/bans/${created.body.ban.id}`)).status).toBe(404);

    const afterwards = await admin.api<{ bans: AdminBan[] }>('GET', '/bans');
    expect(afterwards.body.bans.map((b) => b.id)).not.toContain(created.body.ban.id);
    const history = await admin.api<{ bans: AdminBan[] }>('GET', '/bans?includeExpired=true');
    expect(history.body.bans.map((b) => b.id)).toContain(created.body.ban.id);

    const actions = (await auditActions(admin)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['ban.create', 'ban.remove']));
  });

  it('bans an IP address', async () => {
    const admin = await h.admin(freshIp());
    const created = await admin.api<{ ban: AdminBan }>('POST', '/bans', {
      type: 'ip',
      value: '192.0.2.77',
      durationMinutes: null,
    });
    expect(created.status).toBe(201);
    expect(created.body.ban.expiresAt).toBeNull();

    const res = await fetch(`${h.baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '192.0.2.77' },
    });
    expect(res.status).toBe(403);
    const other = await fetch(`${h.baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '192.0.2.78' },
    });
    expect(other.status).toBe(201);
    await admin.api('DELETE', `/bans/${created.body.ban.id}`);
  });

  it('validates bans', async () => {
    const admin = await h.admin(freshIp());
    expect((await admin.api('POST', '/bans', { type: 'ip', value: 'not-an-ip' })).status).toBe(400);
    expect(
      (await admin.api('POST', '/bans', { type: 'user', value: crypto.randomUUID() })).status,
    ).toBe(404);
    expect(
      (await admin.api('POST', '/bans', { type: 'ip', value: '192.0.2.1', durationMinutes: -5 }))
        .status,
    ).toBe(400);
    expect((await admin.api('POST', '/bans', { type: 'other', value: 'x' })).status).toBe(400);
  });
});

describe('admin chat moderation', () => {
  it('lists messages and deletes one for everyone in the room', async () => {
    const admin = await h.admin(freshIp());
    const host = await h.guest();
    const code = await openRoom(host);
    const hostSocket = await host.socket();
    await joinRoom(hostSocket, code);
    const guest = await h.guest();
    const guestSocket = await guest.socket();
    await joinRoom(guestSocket, code);

    const sent = next(hostSocket, 'chat:message', (m) => m.kind === 'user');
    guestSocket.emit('chat:send', { body: 'something rude' });
    const message = await sent;

    const listed = await admin.api<{ messages: AdminChatMessage[] }>(
      'GET',
      `/chat?roomCode=${code}&q=rude`,
    );
    expect(listed.body.messages).toHaveLength(1);
    expect(listed.body.messages[0]).toMatchObject({
      id: message.id,
      userId: guest.user.id,
      roomCode: code,
      deleted: false,
    });

    const deleted = next(hostSocket, 'chat:deleted');
    expect((await admin.api('DELETE', `/chat/${message.id}`)).status).toBe(204);
    expect(await deleted).toEqual({ id: message.id });
    expect((await admin.api('DELETE', `/chat/${message.id}`)).status).toBe(404);
    expect((await admin.api('DELETE', '/chat/nope')).status).toBe(404);

    const after = await admin.api<{ messages: AdminChatMessage[] }>(
      'GET',
      `/chat?roomCode=${code}`,
    );
    expect(after.body.messages[0]!.deleted).toBe(true);

    const late = await h.guest();
    const { state } = await joinRoom(await late.socket(), code);
    expect(state?.chat.some((m) => m.id === message.id)).toBe(false);
    expect((await auditActions(admin, 'chat.delete'))[0]).toMatchObject({ targetId: message.id });
  });

  it('applies an edited word filter to new messages', async () => {
    const admin = await h.admin(freshIp());
    const host = await h.guest();
    const code = await openRoom(host);
    const socket = await host.socket();
    await joinRoom(socket, code);
    await admin.api('PUT', '/settings/moderation.wordFilter', { value: ['frobnicate'] });
    const sent = next(socket, 'chat:message', (m) => m.kind === 'user');
    socket.emit('chat:send', { body: 'please frobnicate this' });
    expect(((await sent) as { body: string }).body).not.toContain('frobnicate');
    await admin.api('PUT', '/settings/moderation.wordFilter', { value: [] });
  });
});

describe('maintenance mode and announcements', () => {
  it('turns guests away with 503 but lets the admin and /api/site through', async () => {
    const admin = await h.admin(freshIp());
    const guest = await h.guest();
    expect((await admin.api('PUT', '/settings/site.maintenanceMode', { value: true })).status).toBe(
      200,
    );

    expect((await guest.api('GET', '/me')).status).toBe(503);
    expect((await guest.api('GET', '/rooms')).body).toMatchObject({ error: 'maintenance' });
    const site = await fetch(`${h.baseUrl}/api/site`);
    expect(await site.json()).toEqual({ maintenance: true, announcement: null, gifs: true });
    expect((await fetch(`${h.baseUrl}/api/health`)).status).toBe(200);
    expect((await admin.api('GET', '/settings')).status).toBe(200);

    await admin.api('PUT', '/settings/site.maintenanceMode', { value: false });
    expect((await guest.api('GET', '/me')).status).toBe(200);
    expect(
      ((await (await fetch(`${h.baseUrl}/api/site`)).json()) as { maintenance: boolean })
        .maintenance,
    ).toBe(false);
  });

  it('refuses new sockets, drops existing ones and admits admin sockets', async () => {
    const admin = await h.admin(freshIp());
    const guest = await h.guest();
    const socket = await guest.socket();
    const dropped = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));

    await admin.api('PUT', '/settings/site.maintenanceMode', { value: true });
    await dropped;
    await expect(connected(h.connect(guest.cookie))).rejects.toThrow('maintenance');
    await connected(h.connect(`${guest.cookie}; ${admin.cookie}`));
    await admin.api('PUT', '/settings/site.maintenanceMode', { value: false });
  });

  it('pushes announcements live and to sockets that connect later', async () => {
    const admin = await h.admin(freshIp());
    const guest = await h.guest();
    const socket = await guest.socket();
    const pushed = next(socket, 'site:announcement');
    const value = { text: 'Back at 5pm', level: 'warning' };
    await admin.api('PUT', '/settings/site.announcement', { value });
    expect(await pushed).toEqual({ announcement: value });

    const late = h.connect(guest.cookie);
    const seen = next(late, 'site:announcement');
    await connected(late);
    expect(await seen).toEqual({ announcement: value });

    const cleared = next(socket, 'site:announcement', (p) => p.announcement === null);
    await admin.api('PUT', '/settings/site.announcement', { value: null });
    await cleared;
    expect(
      (
        await admin.api('PUT', '/settings/site.announcement', {
          value: { text: '', level: 'info' },
        })
      ).status,
    ).toBe(400);
  });
});

describe('admin quota', () => {
  it('reports today against the budget and 14 days of history', async () => {
    const admin = await h.admin(freshIp());
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(
      new Date(),
    );
    await h.quota.add(today, 300, 3);
    const res = await admin.api<AdminQuotaResponse>('GET', '/quota');
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(14);
    expect(res.body.days.at(-1)).toEqual({ date: today, units: 300, searchCalls: 3 });
    expect(res.body.today).toEqual({ date: today, units: 300, searchCalls: 3 });
    expect(res.body.searchCallBudget).toBe(95);
    const dates = res.body.days.map((d) => d.date);
    expect(new Set(dates).size).toBe(14);
    expect([...dates].sort()).toEqual(dates);
    expect(res.body.days[0]).toMatchObject({ units: 0, searchCalls: 0 });
  });
});

describe('admin namespace', () => {
  it('refuses connections without an admin session', async () => {
    const guest = await h.guest();
    const socket = h.adminNamespace(guest.cookie);
    await expect(connected(socket as never)).rejects.toThrow('unauthenticated');
  });

  it('pushes live counts of rooms and users online', async () => {
    const admin = await h.admin(freshIp());
    const host = await h.guest();
    await openRoom(host);
    await host.socket();
    const socket = h.adminNamespace(admin.cookie);
    const stats = await new Promise<AdminStats>((resolve, reject) => {
      socket.once('admin:stats', resolve);
      socket.once('connect_error', reject);
    });
    expect(stats.rooms).toBeGreaterThanOrEqual(1);
    expect(stats.usersOnline).toBeGreaterThanOrEqual(1);
    await sleep(0);
  });
});

describe('audit log', () => {
  it('filters by action and pages through entries', async () => {
    const admin = await h.admin(freshIp());
    for (let i = 0; i < 3; i++) {
      await admin.api('PUT', '/settings/limits.maxQueueLength', { value: 100 + i });
    }
    const filtered = await admin.api<AuditListResponse>(
      'GET',
      '/audit?action=settings.update&limit=2',
    );
    expect(filtered.body.entries).toHaveLength(2);
    expect(filtered.body.entries.every((e) => e.action === 'settings.update')).toBe(true);
    expect(filtered.body.nextBefore).not.toBeNull();

    const page2 = await admin.api<AuditListResponse>(
      'GET',
      `/audit?action=settings.update&limit=2&before=${filtered.body.nextBefore}`,
    );
    expect(page2.body.entries[0]!.id).toBeLessThan(filtered.body.entries.at(-1)!.id);

    const byTarget = await admin.api<AuditListResponse>('GET', '/audit?targetType=room');
    expect(byTarget.body.entries.every((e) => e.targetType === 'room')).toBe(true);
    expect((await admin.api('GET', '/audit?limit=0')).status).toBe(400);
    await admin.api('PUT', '/settings/limits.maxQueueLength', { value: 200 });
  });
});
