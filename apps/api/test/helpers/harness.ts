import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Redis } from 'ioredis';
import pg from 'pg';
import { io as connectClient, type Socket } from 'socket.io-client';
import {
  sessionResponseSchema,
  type ClientToServerEvents,
  type JoinAck,
  type RoomState,
  type ServerToClientEvents,
  type SocketError,
  type User,
} from '@spotibay/shared';
import { createApp } from '../../src/app.js';
import * as schema from '../../src/db/schema.js';
import { createIdentityService } from '../../src/services/identity.js';
import { createPlaybackService } from '../../src/services/playback.js';
import { createPlaybackStore } from '../../src/services/playback-store.js';
import {
  createQueueStore,
  createQuotaStore,
  createTrackStore,
} from '../../src/services/queue-store.js';
import { createYouTubeService } from '../../src/services/youtube.js';
import { createPresence } from '../../src/services/presence.js';
import { createRoomLifecycle } from '../../src/services/room-lifecycle.js';
import { createRoomService } from '../../src/services/rooms.js';
import { createLibraryService } from '../../src/services/library.js';
import { createPlaylistService } from '../../src/services/playlists.js';
import { createSearchService } from '../../src/services/search.js';
import { createSettingsService } from '../../src/services/settings.js';
import { createBanStore, createRoomStore, createUserStore } from '../../src/services/user-store.js';
import { createSocketServer } from '../../src/socket/server.js';

const TEST_DB_NAME = 'spotibay_test';
const TEST_REDIS_DB = 15;
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

function withPath(url: string, path: string): string {
  const parsed = new URL(url);
  parsed.pathname = path;
  return parsed.toString();
}

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgres://spotibay:spotibay@localhost:5432/spotibay';
const baseRedisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

async function ensureTestDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: baseDatabaseUrl });
  await admin.connect();
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [
      TEST_DB_NAME,
    ]);
    if (exists.rowCount === 0) await admin.query(`create database ${TEST_DB_NAME}`);
  } finally {
    await admin.end();
  }
}

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Canned `videos.list` data for the fake YouTube API: id -> details. */
export interface FakeVideo {
  title?: string;
  durationSec: number;
  embeddable?: boolean;
}

const isoDuration = (sec: number) =>
  `PT${Math.floor(sec / 3600)}H${Math.floor((sec % 3600) / 60)}M${sec % 60}S`;

export interface HarnessOptions {
  hostGraceMs?: number;
  emptyTtlMs?: number;
}

export async function createHarness(options: HarnessOptions = {}) {
  await ensureTestDatabase();
  const pool = new pg.Pool({
    connectionString: withPath(baseDatabaseUrl, `/${TEST_DB_NAME}`),
    max: 5,
  });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder });
  const redis = new Redis(withPath(baseRedisUrl, `/${TEST_REDIS_DB}`));
  await redis.flushdb();
  await db.execute('truncate table users, admins, tracks, api_quota_usage cascade');

  const settings = createSettingsService(
    { loadAll: async () => new Map(), upsert: async () => undefined },
    { bump: async () => 1 },
  );
  await settings.load();

  const identity = createIdentityService(createUserStore(db), {
    jwtSecret: 'j'.repeat(40),
    recoveryHmacSecret: 'r'.repeat(40),
  });
  const bans = createBanStore(db);
  const presence = createPresence(redis);
  const playbackStore = createPlaybackStore(redis);
  const rooms = createRoomService({
    store: createRoomStore(db),
    presence,
    settings,
    nowPlaying: playbackStore.nowPlaying,
  });
  const videos = new Map<string, FakeVideo>();
  const youtubeCalls: string[][] = [];
  /** Canned `search.list` answers: query -> video ids. `searchCalls` records the queries asked. */
  const searchResults = new Map<string, string[]>();
  const searchCalls: string[] = [];
  /** Canned `playlistItems.list` data: playlist id -> video ids; an absent id answers 404. */
  const playlistPages = new Map<string, string[]>();
  const fakeFetch = (async (input: URL | string) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/playlistItems')) {
      const all = playlistPages.get(url.searchParams.get('playlistId') ?? '');
      if (!all) return new Response('{}', { status: 404 });
      // Two items per page so tests exercise paging.
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const page = all.slice(start, start + 2);
      const nextPageToken = start + 2 < all.length ? String(start + 2) : undefined;
      const items = page.map((videoId) => ({ contentDetails: { videoId } }));
      return new Response(JSON.stringify({ items, nextPageToken }), { status: 200 });
    }
    if (url.pathname.endsWith('/search')) {
      const q = url.searchParams.get('q') ?? '';
      searchCalls.push(q);
      const items = (searchResults.get(q) ?? []).map((videoId) => ({ id: { videoId } }));
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    const ids = (new URL(input).searchParams.get('id') ?? '').split(',');
    youtubeCalls.push(ids);
    const items = ids.flatMap((id) => {
      const v = videos.get(id);
      return v
        ? [
            {
              id,
              snippet: {
                title: v.title ?? `Track ${id}`,
                channelTitle: 'Test Channel',
                thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } },
              },
              contentDetails: { duration: isoDuration(v.durationSec) },
              status: { embeddable: v.embeddable ?? true, privacyStatus: 'public' },
            },
          ]
        : [];
    });
    return new Response(JSON.stringify({ items }), { status: 200 });
  }) as typeof fetch;
  const quotaStore = createQuotaStore(db);
  const youtube = createYouTubeService({
    apiKey: 'test-key',
    tracks: createTrackStore(db),
    quota: quotaStore,
    fetch: fakeFetch,
  });
  const search = createSearchService({ redis, settings, quota: quotaStore, youtube });
  const playback = createPlaybackService({
    store: playbackStore,
    queue: createQueueStore(db),
    youtube,
    presence,
    rooms,
    settings,
  });
  const playlists = createPlaylistService({ db, youtube, settings });
  const library = createLibraryService({ db });
  const lifecycle = createRoomLifecycle({
    rooms,
    presence,
    hostGraceMs: options.hostGraceMs,
    emptyTtlMs: options.emptyTtlMs,
  });
  const app = createApp({
    identity,
    bans,
    rooms,
    presence,
    playback,
    search,
    playlists,
    library,
    secureCookie: false,
  });
  const httpServer: Server = createServer(app);
  const io = createSocketServer({
    httpServer,
    identity,
    bans,
    rooms,
    presence,
    lifecycle,
    playback,
    playlists,
    maxUsersPerRoom: () => settings.get('limits.maxUsersPerRoom'),
    syncConfig: () => ({
      driftThresholdMs: settings.get('sync.driftThresholdMs'),
      checkIntervalMs: settings.get('sync.checkIntervalMs'),
    }),
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  const sockets = new Set<ClientSocket>();

  function connect(cookie: string): ClientSocket {
    const socket: ClientSocket = connectClient(baseUrl, {
      transports: ['websocket'],
      extraHeaders: { cookie },
      reconnection: false,
    });
    sockets.add(socket);
    return socket;
  }

  async function guest() {
    const res = await fetch(`${baseUrl}/api/session`, { method: 'POST' });
    const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
    const { user } = sessionResponseSchema.parse(await res.json());

    async function api<T = unknown>(method: string, path: string, body?: unknown) {
      const r = await fetch(`${baseUrl}/api${path}`, {
        method,
        headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json().catch(() => null)) as T };
    }

    async function socket(): Promise<ClientSocket> {
      const s = connect(cookie);
      await connected(s);
      return s;
    }

    return { user: user as User, cookie, api, socket };
  }

  async function close() {
    lifecycle.stop();
    playback.stop();
    for (const s of sockets) s.disconnect();
    // Disconnects trigger presence cleanup on the server; let it finish before the stores go away.
    for (let i = 0; i < 100 && (await io.fetchSockets()).length > 0; i++) await sleep(10);
    await sleep(100);
    await io.close();
    await redis.quit();
    await pool.end();
  }

  return {
    baseUrl,
    db,
    redis,
    settings,
    rooms,
    presence,
    playback,
    playlists,
    videos,
    playlistPages,
    youtubeCalls,
    searchResults,
    searchCalls,
    quota: quotaStore,
    guest,
    connect,
    close,
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

type Payload<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>[0];

/** Resolves with the first `event` (matching `predicate`) to arrive on `socket`. */
export function next<E extends keyof ServerToClientEvents>(
  socket: ClientSocket,
  event: E,
  predicate: (payload: Payload<E>) => boolean = () => true,
  timeoutMs = 3000,
): Promise<Payload<E>> {
  return new Promise((resolve, reject) => {
    // socket.io-client's generic listener types can't express a listener generic over `E`.
    const on = (l: (payload: Payload<E>) => void) => socket.on(event, l as never);
    const off = (l: (payload: Payload<E>) => void) => socket.off(event, l as never);
    const timer = setTimeout(() => {
      off(listener);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    function listener(payload: Payload<E>) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      off(listener);
      resolve(payload);
    }
    on(listener);
  });
}

/** Resolves once the socket is connected, or rejects with the server's refusal reason. */
export function connected(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', (err) => reject(err));
  });
}

/** Joins a room and resolves with the ack plus the `room:state` snapshot (when joined). */
export async function joinRoom(
  socket: ClientSocket,
  code: string,
  password?: string,
): Promise<{ ack: JoinAck; state?: RoomState }> {
  const statePromise = next(socket, 'room:state', () => true, 1500).catch(() => undefined);
  const ack = await new Promise<JoinAck>((resolve) => {
    socket.emit('room:join', { code, password }, resolve);
  });
  return { ack, state: ack.ok ? await statePromise : undefined };
}

export function errorOf(ack: JoinAck): SocketError | undefined {
  return ack.ok ? undefined : ack.error;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
