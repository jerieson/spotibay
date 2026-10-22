import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { RoomResponse } from '@spotibay/shared';
import { bans } from '../src/db/schema.js';
import {
  connected,
  createHarness,
  errorOf,
  joinRoom,
  next,
  sleep,
  type ClientSocket,
  type Harness,
} from './helpers/harness.js';

const HOST_GRACE_MS = 250;
const EMPTY_TTL_MS = 250;

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ hostGraceMs: HOST_GRACE_MS, emptyTtlMs: EMPTY_TTL_MS });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.settings.set('limits.maxUsersPerRoom', 30, null);
  await h.settings.set('limits.maxActiveRooms', 50, null);
});

type Guest = Awaited<ReturnType<Harness['guest']>>;

async function createRoom(host: Guest, body: Record<string, unknown> = {}) {
  const res = await host.api<RoomResponse>('POST', '/rooms', { name: 'Test room', ...body });
  expect(res.status).toBe(201);
  return res.body.room;
}

describe('connection', () => {
  it('refuses sockets without a valid session', async () => {
    const socket = h.connect('spotibay_session=garbage');
    await expect(connected(socket)).rejects.toThrow('unauthenticated');
  });

  it('refuses banned users', async () => {
    const guest = await h.guest();
    await h.db.insert(bans).values({ type: 'user', value: guest.user.id, reason: 'spam' });
    await expect(connected(h.connect(guest.cookie))).rejects.toThrow('banned');
    await h.db.delete(bans).where(eq(bans.value, guest.user.id));
  });

  it('answers time:ping with the server clock', async () => {
    const guest = await h.guest();
    const socket = await guest.socket();
    const pong = next(socket, 'time:pong');
    const before = Date.now();
    socket.emit('time:ping', { t0: 123 });
    const res = await pong;
    expect(res.t0).toBe(123);
    expect(res.serverTime).toBeGreaterThanOrEqual(before);
    expect(res.serverTime).toBeLessThanOrEqual(Date.now());
  });

  it('reports invalid payloads without dropping the connection', async () => {
    const guest = await h.guest();
    const socket = await guest.socket();
    const err = next(socket, 'error');
    socket.emit('room:update', { name: '' });
    expect((await err).code).toBe('invalid_payload');
    const ack = await new Promise<Awaited<ReturnType<typeof joinRoom>>['ack']>((resolve) => {
      socket.emit('room:join', { code: 'abc' }, resolve);
    });
    expect(errorOf(ack)?.code).toBe('invalid_payload');
    expect(socket.connected).toBe(true);
  });
});

describe('room:join', () => {
  it('sends the joiner a snapshot and updates everyone else', async () => {
    const host = await h.guest();
    const guest = await h.guest();
    const room = await createRoom(host);
    const hostSocket = await host.socket();
    const guestSocket = await guest.socket();

    const first = await joinRoom(hostSocket, room.code);
    expect(first.ack.ok).toBe(true);
    expect(first.state?.you).toEqual({ userId: host.user.id, role: 'host' });
    expect(first.state?.room).toMatchObject({ code: room.code, hostId: host.user.id });
    expect(first.state?.members.map((m) => m.userId)).toEqual([host.user.id]);

    const hostSees = next(hostSocket, 'room:members', (p) => p.members.length === 2);
    const second = await joinRoom(guestSocket, room.code.toLowerCase());
    expect(second.state?.you).toEqual({ userId: guest.user.id, role: 'listener' });
    expect(second.state?.members.map((m) => m.userId)).toEqual([host.user.id, guest.user.id]);

    const members = (await hostSees).members;
    expect(members.find((m) => m.userId === guest.user.id)).toMatchObject({
      displayName: guest.user.displayName,
      avatar: guest.user.avatar,
      role: 'listener',
    });
  });

  it('fails for unknown and closed rooms', async () => {
    const host = await h.guest();
    const socket = await host.socket();
    expect(errorOf((await joinRoom(socket, 'ZZZZZZ')).ack)?.code).toBe('room_not_found');

    const room = await createRoom(host);
    await host.api('POST', `/rooms/${room.code}/close`);
    expect(errorOf((await joinRoom(socket, room.code)).ack)?.code).toBe('room_closed');
  });

  it('requires the password for protected rooms, except for the host', async () => {
    const host = await h.guest();
    const guest = await h.guest();
    const room = await createRoom(host, { visibility: 'private', password: 'opensesame' });
    const hostSocket = await host.socket();
    const guestSocket = await guest.socket();

    expect(errorOf((await joinRoom(guestSocket, room.code)).ack)?.code).toBe('wrong_password');
    expect(errorOf((await joinRoom(guestSocket, room.code, 'nope-nope')).ack)?.code).toBe(
      'wrong_password',
    );
    expect((await joinRoom(guestSocket, room.code, 'opensesame')).ack.ok).toBe(true);
    expect((await joinRoom(hostSocket, room.code)).ack.ok).toBe(true);
  });

  it('allows joining a private room without a password when none is set', async () => {
    const host = await h.guest();
    const guest = await h.guest();
    const room = await createRoom(host, { visibility: 'private' });
    expect((await joinRoom(await guest.socket(), room.code)).ack.ok).toBe(true);
  });

  it('enforces limits.maxUsersPerRoom but counts a user once across tabs', async () => {
    await h.settings.set('limits.maxUsersPerRoom', 2, null);
    const [a, b, c] = [await h.guest(), await h.guest(), await h.guest()];
    const room = await createRoom(a);

    const aTab1 = await a.socket();
    const aTab2 = await a.socket();
    expect((await joinRoom(aTab1, room.code)).ack.ok).toBe(true);
    // a second tab of the same user does not take another seat
    expect((await joinRoom(aTab2, room.code)).ack.ok).toBe(true);
    expect((await joinRoom(await b.socket(), room.code)).ack.ok).toBe(true);
    expect(errorOf((await joinRoom(await c.socket(), room.code)).ack)?.code).toBe('room_full');

    const members = await h.presence.list((await h.rooms.findByCode(room.code))!.id);
    expect(members.map((m) => m.userId)).toEqual([a.user.id, b.user.id]);
  });

  it('keeps a user in the room until their last tab leaves', async () => {
    const host = await h.guest();
    const guest = await h.guest();
    const room = await createRoom(host);
    const hostSocket = await host.socket();
    await joinRoom(hostSocket, room.code);

    const tab1 = await guest.socket();
    const tab2 = await guest.socket();
    await joinRoom(tab1, room.code);
    await joinRoom(tab2, room.code);

    tab1.disconnect();
    await sleep(100);
    const id = (await h.rooms.findByCode(room.code))!.id;
    expect((await h.presence.list(id)).map((m) => m.userId)).toContain(guest.user.id);

    const gone = next(hostSocket, 'room:members', (p) => p.members.length === 1);
    tab2.emit('room:leave');
    expect((await gone).members.map((m) => m.userId)).toEqual([host.user.id]);
  });

  it('moves a socket from one room to another', async () => {
    const host = await h.guest();
    const guest = await h.guest();
    const [r1, r2] = [await createRoom(host), await createRoom(host)];
    const socket = await guest.socket();
    await joinRoom(socket, r1.code);
    await joinRoom(socket, r2.code);
    const [id1, id2] = [
      (await h.rooms.findByCode(r1.code))!.id,
      (await h.rooms.findByCode(r2.code))!.id,
    ];
    expect(await h.presence.count(id1)).toBe(0);
    expect(await h.presence.count(id2)).toBe(1);
  });
});

describe('roles', () => {
  async function roomWith(guests: Guest[], host: Guest) {
    const room = await createRoom(host);
    const sockets: ClientSocket[] = [];
    for (const g of [host, ...guests]) {
      const s = await g.socket();
      await joinRoom(s, room.code);
      sockets.push(s);
    }
    return { room, sockets };
  }

  it('lets the host promote a listener to DJ and back', async () => {
    const [host, guest] = [await h.guest(), await h.guest()];
    const { sockets } = await roomWith([guest], host);
    const [hostSocket, guestSocket] = sockets as [ClientSocket, ClientSocket];

    const promoted = next(guestSocket, 'room:members', (p) =>
      p.members.some((m) => m.userId === guest.user.id && m.role === 'dj'),
    );
    hostSocket.emit('room:setRole', { userId: guest.user.id, role: 'dj' });
    await promoted;

    const demoted = next(guestSocket, 'room:members', (p) =>
      p.members.some((m) => m.userId === guest.user.id && m.role === 'listener'),
    );
    hostSocket.emit('room:setRole', { userId: guest.user.id, role: 'listener' });
    await demoted;
  });

  it('rejects role changes from non-hosts and for the host', async () => {
    const [host, a, b] = [await h.guest(), await h.guest(), await h.guest()];
    const { sockets } = await roomWith([a, b], host);
    const [hostSocket, aSocket] = sockets as [ClientSocket, ClientSocket, ClientSocket];

    const denied = next(aSocket, 'error');
    aSocket.emit('room:setRole', { userId: b.user.id, role: 'dj' });
    expect((await denied).code).toBe('forbidden');

    const hostDenied = next(hostSocket, 'error');
    hostSocket.emit('room:setRole', { userId: host.user.id, role: 'dj' });
    expect((await hostDenied).code).toBe('forbidden');

    const missing = next(hostSocket, 'error');
    hostSocket.emit('room:setRole', { userId: '00000000-0000-4000-8000-000000000000', role: 'dj' });
    expect((await missing).code).toBe('user_not_in_room');
  });

  it('transfers the host role on request', async () => {
    const [host, guest] = [await h.guest(), await h.guest()];
    const { room, sockets } = await roomWith([guest], host);
    const [hostSocket, guestSocket] = sockets as [ClientSocket, ClientSocket];

    const updated = next(guestSocket, 'room:updated');
    const members = next(guestSocket, 'room:members', (p) =>
      p.members.some((m) => m.userId === guest.user.id && m.role === 'host'),
    );
    hostSocket.emit('room:transferHost', { userId: guest.user.id });
    expect((await updated).room.hostId).toBe(guest.user.id);
    const roles = Object.fromEntries((await members).members.map((m) => [m.userId, m.role]));
    expect(roles).toEqual({ [host.user.id]: 'listener', [guest.user.id]: 'host' });

    // the old host can no longer manage the room, the new one can
    const denied = next(hostSocket, 'error');
    hostSocket.emit('room:update', { name: 'Mine' });
    expect((await denied).code).toBe('forbidden');
    const renamed = next(hostSocket, 'room:updated');
    guestSocket.emit('room:update', { name: 'Theirs' });
    expect((await renamed).room.name).toBe('Theirs');
    expect((await host.api('PATCH', `/rooms/${room.code}`, { name: 'x' })).status).toBe(403);
  });

  it('passes the host role to the longest-present member after the grace period', async () => {
    const [host, first, second] = [await h.guest(), await h.guest(), await h.guest()];
    const room = await createRoom(host);
    const hostSocket = await host.socket();
    await joinRoom(hostSocket, room.code);
    const firstSocket = await first.socket();
    await joinRoom(firstSocket, room.code);
    await sleep(20);
    const secondSocket = await second.socket();
    await joinRoom(secondSocket, room.code);

    const updated = next(secondSocket, 'room:updated', () => true, HOST_GRACE_MS + 2000);
    hostSocket.disconnect();
    const { room: after } = await updated;
    expect(after.hostId).toBe(first.user.id);

    const stored = await h.rooms.findByCode(room.code);
    expect(stored?.ownerId).toBe(first.user.id);
    const roles = Object.fromEntries(
      (await h.presence.list(stored!.id)).map((m) => [m.userId, m.role]),
    );
    expect(roles).toEqual({ [first.user.id]: 'host', [second.user.id]: 'listener' });
  });

  it('keeps the host if they return within the grace period', async () => {
    const [host, guest] = [await h.guest(), await h.guest()];
    const room = await createRoom(host);
    const hostSocket = await host.socket();
    await joinRoom(hostSocket, room.code);
    await joinRoom(await guest.socket(), room.code);

    hostSocket.disconnect();
    await sleep(HOST_GRACE_MS / 3);
    const back = await joinRoom(await host.socket(), room.code);
    expect(back.state?.you.role).toBe('host');

    await sleep(HOST_GRACE_MS + 150);
    expect((await h.rooms.findByCode(room.code))?.ownerId).toBe(host.user.id);
  });

  it('hands over the host role when the host never shows up', async () => {
    const [host, guest] = [await h.guest(), await h.guest()];
    const room = await createRoom(host);
    const guestSocket = await guest.socket();
    const updated = next(guestSocket, 'room:updated', () => true, HOST_GRACE_MS + 2000);
    await joinRoom(guestSocket, room.code);
    expect((await updated).room.hostId).toBe(guest.user.id);
  });
});

describe('room lifecycle', () => {
  it('broadcasts room:closed when the host closes the room', async () => {
    const [host, guest] = [await h.guest(), await h.guest()];
    const room = await createRoom(host);
    const guestSocket = await guest.socket();
    await joinRoom(guestSocket, room.code);

    const closed = next(guestSocket, 'room:closed');
    await host.api('POST', `/rooms/${room.code}/close`);
    expect(await closed).toEqual({ reason: 'host' });
    expect(await h.presence.count((await h.rooms.findByCode(room.code))!.id)).toBe(0);
  });

  it('pushes REST updates to people in the room', async () => {
    const [host, guest] = [await h.guest(), await h.guest()];
    const room = await createRoom(host);
    const guestSocket = await guest.socket();
    await joinRoom(guestSocket, room.code);

    const updated = next(guestSocket, 'room:updated');
    await host.api('PATCH', `/rooms/${room.code}`, { name: 'Renamed' });
    expect((await updated).room.name).toBe('Renamed');
  });

  it('closes a room that stays empty', async () => {
    const host = await h.guest();
    const room = await createRoom(host);
    const socket = await host.socket();
    await joinRoom(socket, room.code);
    socket.emit('room:leave');

    await sleep(EMPTY_TTL_MS + 400);
    expect((await host.api('GET', `/rooms/${room.code}`)).status).toBe(410);
  });

  it('closes a room nobody ever joined, but not one that is in use', async () => {
    const host = await h.guest();
    const unused = await createRoom(host);
    const used = await createRoom(host);
    await joinRoom(await host.socket(), used.code);

    await sleep(EMPTY_TTL_MS + 400);
    expect((await host.api('GET', `/rooms/${used.code}`)).status).toBe(200);
    expect((await host.api('GET', `/rooms/${unused.code}`)).status).toBe(410);
  });
});
