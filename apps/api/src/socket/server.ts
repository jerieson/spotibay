import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  SESSION_COOKIE,
  clientEventSchemas,
  type ClientToServerEvents,
  type JoinAck,
  type ServerToClientEvents,
  type SocketErrorCode,
  type RoomRole,
  type RoomState,
  type SyncConfig,
} from '@spotibay/shared';
import { readCookie } from '../middleware/session.js';
import type { BanStore } from '../services/bans.js';
import type { IdentityService, UserRecord } from '../services/identity.js';
import { PlaybackError, type PlaybackService } from '../services/playback.js';
import { PlaylistError, type PlaylistService } from '../services/playlists.js';
import type { Presence } from '../services/presence.js';
import type { RoomLifecycle } from '../services/room-lifecycle.js';
import { RoomError, toRoom, type RoomRow, type RoomService } from '../services/rooms.js';

interface SocketData {
  user: UserRecord;
  ip: string;
  roomId?: string;
  /** Handlers for one socket run one at a time, in arrival order. */
  queue: Promise<void>;
}

type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type EventName = keyof typeof clientEventSchemas;

export interface SocketServerDeps {
  httpServer: HttpServer;
  identity: IdentityService;
  bans: BanStore;
  rooms: RoomService;
  presence: Presence;
  lifecycle: RoomLifecycle;
  playback: PlaybackService;
  playlists: Pick<PlaylistService, 'videoIdsForQueue'>;
  maxUsersPerRoom: () => number;
  syncConfig: () => SyncConfig;
  onError?: (err: unknown) => void;
}

const roomChannel = (roomId: string) => `room:${roomId}`;

/** Behind Caddy the last `X-Forwarded-For` entry is the address Caddy saw. */
function clientIp(req: IncomingMessage, fallback: string): string {
  const header = req.headers['x-forwarded-for'];
  const value = Array.isArray(header) ? header.join(',') : header;
  const last = value?.split(',').pop()?.trim();
  return last || fallback;
}

export function createSocketServer(deps: SocketServerDeps) {
  const {
    identity,
    bans,
    rooms,
    presence,
    lifecycle,
    playback,
    playlists,
    onError = (e) => console.error(e),
  } = deps;
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(deps.httpServer, { serveClient: false });

  io.use(async (socket, next) => {
    try {
      const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
      const claims = token ? await identity.verifySession(token) : null;
      const user = claims ? await identity.getUser(claims.userId) : null;
      if (!user) {
        next(new Error('unauthenticated'));
        return;
      }
      const ip = clientIp(socket.request, socket.handshake.address);
      if (await isBanned(user, ip)) {
        next(new Error('banned'));
        return;
      }
      socket.data.user = user;
      socket.data.ip = ip;
      socket.data.queue = Promise.resolve();
      next();
    } catch (err) {
      onError(err);
      next(new Error('internal_error'));
    }
  });

  async function isBanned(user: UserRecord, ip: string): Promise<boolean> {
    if (user.bannedUntil && user.bannedUntil.getTime() > Date.now()) return true;
    return (await bans.findActiveBan({ userId: user.id, ip })) !== null;
  }

  function fail(socket: AppSocket, code: SocketErrorCode, message: string) {
    socket.emit('error', { code, message });
  }

  /** Runs `fn` after the socket's earlier handlers finish; failures become an `error` event. */
  function enqueue(socket: AppSocket, fn: () => Promise<void>) {
    socket.data.queue = socket.data.queue.then(fn).catch((err: unknown) => {
      if (err instanceof RoomError) {
        fail(socket, socketCodeFor(err), err.message);
        return;
      }
      if (err instanceof PlaylistError) {
        fail(socket, err.code === 'playlist_not_found' ? err.code : 'invalid_payload', err.message);
        return;
      }
      if (err instanceof PlaybackError) {
        fail(socket, err.code, err.message);
        return;
      }
      onError(err);
      fail(socket, 'internal_error', 'Something went wrong');
    });
  }

  function socketCodeFor(err: RoomError): SocketErrorCode {
    switch (err.code) {
      case 'room_not_found':
      case 'room_closed':
      case 'forbidden':
      case 'user_not_in_room':
        return err.code;
      default:
        return 'invalid_payload';
    }
  }

  function parse<E extends EventName>(socket: AppSocket, event: E, raw: unknown) {
    const result = clientEventSchemas[event].safeParse(raw);
    if (!result.success) {
      fail(socket, 'invalid_payload', result.error.issues[0]?.message ?? 'Invalid payload');
      return null;
    }
    return result.data as import('zod').infer<(typeof clientEventSchemas)[E]>;
  }

  async function roomStateFor(row: RoomRow, userId: string): Promise<RoomState | null> {
    const members = await presence.list(row.id);
    const you = members.find((m) => m.userId === userId);
    if (!you) return null;
    const { playback: state, queue, skipVotes } = await playback.snapshot(row.id);
    return {
      room: toRoom(row),
      members,
      you: { userId, role: you.role },
      playback: state,
      queue,
      skipVotes,
      sync: deps.syncConfig(),
    };
  }

  async function broadcastMembers(roomId: string) {
    io.to(roomChannel(roomId)).emit('room:members', { members: await presence.list(roomId) });
    // The skip threshold depends on how many people are here.
    await playback.refreshSkipVotes(roomId);
  }

  /** The room this socket is in, but only if its user is still a member and the room is open. */
  async function currentRoom(socket: AppSocket): Promise<{ row: RoomRow; role: RoomRole } | null> {
    const roomId = socket.data.roomId;
    if (!roomId) return null;
    const [row, member] = await Promise.all([
      rooms.findById(roomId),
      presence.get(roomId, socket.data.user.id),
    ]);
    return row && !row.closedAt && member ? { row, role: member.role } : null;
  }

  async function leaveCurrentRoom(socket: AppSocket) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.data.roomId = undefined;
    await socket.leave(roomChannel(roomId));
    const { removed } = await presence.leave(roomId, socket.data.user.id);
    if (removed) await broadcastMembers(roomId);
    await lifecycle.reconcile(roomId);
  }

  async function join(socket: AppSocket, raw: unknown): Promise<JoinAck> {
    const payload = parse(socket, 'room:join', raw);
    if (!payload)
      return { ok: false, error: { code: 'invalid_payload', message: 'Invalid payload' } };
    const reject = (code: SocketErrorCode, message: string): JoinAck => ({
      ok: false,
      error: { code, message },
    });

    const user = socket.data.user;
    const row = await rooms.findByCode(payload.code);
    if (!row) return reject('room_not_found', 'Room not found');
    if (row.closedAt) return reject('room_closed', 'This room has been closed');
    if (await isBanned(user, socket.data.ip)) return reject('banned', 'You are banned');

    if (socket.data.roomId === row.id && (await presence.get(row.id, user.id))) {
      const state = await roomStateFor(row, user.id);
      if (state) socket.emit('room:state', state);
      return { ok: true };
    }
    await leaveCurrentRoom(socket);

    const isHost = row.ownerId === user.id;
    if (!isHost && !(await rooms.checkPassword(row, payload.password))) {
      return reject('wrong_password', 'Wrong room password');
    }
    const joined = await presence.join(
      row.id,
      user,
      isHost ? 'host' : 'listener',
      deps.maxUsersPerRoom(),
    );
    if (!joined.ok) return reject('room_full', 'This room is full');

    socket.data.roomId = row.id;
    await socket.join(roomChannel(row.id));
    const state = await roomStateFor(row, user.id);
    if (state) socket.emit('room:state', state);
    if (joined.isNew) await broadcastMembers(row.id);
    await lifecycle.reconcile(row.id);
    return { ok: true };
  }

  io.on('connection', (socket) => {
    socket.on('time:ping', (raw: unknown) => {
      const payload = parse(socket, 'time:ping', raw);
      if (payload) socket.emit('time:pong', { t0: payload.t0, serverTime: Date.now() });
    });

    socket.on('room:join', (raw: unknown, ack?: (res: JoinAck) => void) => {
      enqueue(socket, async () => {
        const res = await join(socket, raw);
        if (typeof ack === 'function') ack(res);
      });
    });

    socket.on('room:leave', () => enqueue(socket, () => leaveCurrentRoom(socket)));

    socket.on('room:update', (raw: unknown) => {
      enqueue(socket, async () => {
        const payload = parse(socket, 'room:update', raw);
        if (!payload) return;
        const current = await currentRoom(socket);
        if (!current) return fail(socket, 'not_in_room', 'Join a room first');
        // Broadcast happens through the service's `updated` event.
        await rooms.update(current.row.code, socket.data.user.id, payload);
      });
    });

    socket.on('room:setRole', (raw: unknown) => {
      enqueue(socket, async () => {
        const payload = parse(socket, 'room:setRole', raw);
        if (!payload) return;
        const current = await currentRoom(socket);
        if (!current) return fail(socket, 'not_in_room', 'Join a room first');
        if (current.role !== 'host') return fail(socket, 'forbidden', 'Only the host can do that');
        const target = await presence.get(current.row.id, payload.userId);
        if (!target) return fail(socket, 'user_not_in_room', 'That person is not in the room');
        if (target.role === 'host')
          return fail(socket, 'forbidden', 'Transfer the host role instead');
        await presence.setRole(current.row.id, payload.userId, payload.role);
        await broadcastMembers(current.row.id);
      });
    });

    socket.on('room:transferHost', (raw: unknown) => {
      enqueue(socket, async () => {
        const payload = parse(socket, 'room:transferHost', raw);
        if (!payload) return;
        const current = await currentRoom(socket);
        if (!current) return fail(socket, 'not_in_room', 'Join a room first');
        if (current.role !== 'host') return fail(socket, 'forbidden', 'Only the host can do that');
        if (payload.userId === socket.data.user.id) return;
        await rooms.transferHost(current.row, payload.userId);
        await lifecycle.reconcile(current.row.id);
      });
    });

    /** A handler that runs `fn` for a member who may control playback (host or DJ). */
    function control(fn: (roomId: string) => Promise<void>) {
      return () => {
        enqueue(socket, async () => {
          const current = await currentRoom(socket);
          if (!current) return fail(socket, 'not_in_room', 'Join a room first');
          if (current.role === 'listener') {
            return fail(socket, 'forbidden', 'Only the host and DJs can do that');
          }
          await fn(current.row.id);
        });
      };
    }
    socket.on(
      'playback:play',
      control((id) => playback.play(id)),
    );
    socket.on(
      'playback:pause',
      control((id) => playback.pause(id)),
    );
    socket.on(
      'playback:skip',
      control((id) => playback.skip(id)),
    );

    socket.on('playback:seek', (raw: unknown) => {
      enqueue(socket, async () => {
        const payload = parse(socket, 'playback:seek', raw);
        if (!payload) return;
        const current = await currentRoom(socket);
        if (!current) return fail(socket, 'not_in_room', 'Join a room first');
        if (current.role === 'listener') {
          return fail(socket, 'forbidden', 'Only the host and DJs can do that');
        }
        await playback.seek(current.row.id, payload.positionMs);
      });
    });

    socket.on('playback:reportUnavailable', (raw: unknown) => {
      enqueue(socket, async () => {
        const payload = parse(socket, 'playback:reportUnavailable', raw);
        if (!payload) return;
        const current = await currentRoom(socket);
        if (!current) return fail(socket, 'not_in_room', 'Join a room first');
        await playback.reportUnavailable(current.row.id, payload.queueItemId);
      });
    });

    socket.on('queue:add', (raw: unknown) => {
      enqueue(socket, async () => {
        const payload = parse(socket, 'queue:add', raw);
        if (!payload) return;
        const current = await currentRoom(socket);
        if (!current) return fail(socket, 'not_in_room', 'Join a room first');
        await playback.add(current.row.id, socket.data.user.id, payload.url);
      });
    });

    socket.on('queue:addMany', (raw: unknown) => {
      enqueue(socket, async () => {
        const payload = parse(socket, 'queue:addMany', raw);
        if (!payload) return;
        const current = await currentRoom(socket);
        if (!current) return fail(socket, 'not_in_room', 'Join a room first');
        const userId = socket.data.user.id;
        const videoIds =
          payload.playlistId !== undefined
            ? await playlists.videoIdsForQueue(userId, payload.playlistId)
            : (payload.videoIds ?? []);
        const result = await playback.addMany(current.row.id, userId, current.role, videoIds);
        socket.emit('queue:addManyResult', result);
      });
    });

    socket.on('playback:voteSkip', () => {
      enqueue(socket, async () => {
        const current = await currentRoom(socket);
        if (!current) return fail(socket, 'not_in_room', 'Join a room first');
        await playback.voteSkip(current.row.id, socket.data.user.id);
      });
    });

    socket.on('queue:remove', (raw: unknown) => {
      enqueue(socket, async () => {
        const payload = parse(socket, 'queue:remove', raw);
        if (!payload) return;
        const current = await currentRoom(socket);
        if (!current) return fail(socket, 'not_in_room', 'Join a room first');
        await playback.remove(
          current.row.id,
          socket.data.user.id,
          current.role,
          payload.queueItemId,
        );
      });
    });

    socket.on('queue:reorder', (raw: unknown) => {
      enqueue(socket, async () => {
        const payload = parse(socket, 'queue:reorder', raw);
        if (!payload) return;
        const current = await currentRoom(socket);
        if (!current) return fail(socket, 'not_in_room', 'Join a room first');
        if (current.role === 'listener') {
          return fail(socket, 'forbidden', 'Only the host and DJs can do that');
        }
        await playback.reorder(current.row.id, payload.queueItemId, payload.toIndex);
      });
    });

    socket.on('queue:vote', (raw: unknown) => {
      enqueue(socket, async () => {
        const payload = parse(socket, 'queue:vote', raw);
        if (!payload) return;
        const current = await currentRoom(socket);
        if (!current) return fail(socket, 'not_in_room', 'Join a room first');
        await playback.vote(
          current.row.id,
          socket.data.user.id,
          payload.queueItemId,
          payload.value,
        );
      });
    });

    socket.on('disconnect', () => {
      enqueue(socket, () => leaveCurrentRoom(socket));
    });
  });

  playback.onPlayback((roomId, state) => {
    io.to(roomChannel(roomId)).emit('playback:state', state);
  });
  playback.onSkipVotes((roomId, votes) => {
    io.to(roomChannel(roomId)).emit('playback:skipVotes', votes);
  });
  playback.onQueue((roomId, queue) => {
    io.to(roomChannel(roomId)).emit('queue:updated', { queue });
  });

  rooms.onUpdated((row) => {
    const channel = roomChannel(row.id);
    io.to(channel).emit('room:updated', { room: toRoom(row) });
    broadcastMembers(row.id).catch(onError);
  });

  rooms.onClosed((row, reason) => {
    const channel = roomChannel(row.id);
    io.to(channel).emit('room:closed', { reason });
    io.in(channel).socketsLeave(channel);
  });

  return io;
}

export type AppSocketServer = ReturnType<typeof createSocketServer>;
