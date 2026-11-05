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
import { io as connectNamespace } from 'socket.io-client';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/lib/password.js';
import { createAdminAuth } from '../../src/services/admin-auth.js';
import { createAdminService } from '../../src/services/admin.js';
import {
  createAdminDataStore,
  createAdminStore,
  createAuditStore,
} from '../../src/services/admin-store.js';
import { createAuditService } from '../../src/services/audit.js';
import { createAutoplayService } from '../../src/services/autoplay.js';
import * as schema from '../../src/db/schema.js';
import { createIdentityService } from '../../src/services/identity.js';
import { createPlaybackService } from '../../src/services/playback.js';
import { createPlaybackStore } from '../../src/services/playback-store.js';
import { createCatalogService } from '../../src/services/catalog.js';
import {
  createCatalogMatchStore,
  createQueueStore,
  createQuotaStore,
  createTrackStore,
} from '../../src/services/queue-store.js';
import { createYouTubeService } from '../../src/services/youtube.js';
import { createPresence } from '../../src/services/presence.js';
import { createRoomLifecycle } from '../../src/services/room-lifecycle.js';
import { createRoomService } from '../../src/services/rooms.js';
import { createChatService } from '../../src/services/chat.js';
import { createChatStore } from '../../src/services/chat-store.js';
import { createGifService } from '../../src/services/gifs.js';
import { createLibraryService } from '../../src/services/library.js';
import { createPlaylistService } from '../../src/services/playlists.js';
import { createSearchService } from '../../src/services/search.js';
import { createVibeService } from '../../src/services/vibes.js';
import { createRecommendationService } from '../../src/services/recommendations.js';
import { createMusicBrainzLinks, createOdesliLinks } from '../../src/services/song-links.js';
import { createLastfmSimilar } from '../../src/services/similar.js';
import { createMetrics } from '../../src/lib/metrics.js';
import { createSettingsService } from '../../src/services/settings.js';
import { createBanStore, createRoomStore, createUserStore } from '../../src/services/user-store.js';
import { createSocketServer } from '../../src/socket/server.js';

export const ADMIN_USERNAME = 'admin';
export const ADMIN_PASSWORD = 'correct horse battery';
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
  channelTitle?: string;
  durationSec: number;
  embeddable?: boolean;
}

/** A song in the fake Deezer catalog. */
export interface FakeSong {
  title: string;
  artist: string;
  album?: string;
  durationSec: number;
  readable?: boolean;
  isrc?: string;
  /** Deezer popularity. */
  rank?: number;
  /** Deezer artist id. */
  artistId?: string;
}

/** An entry of the fake Apple Music chart. */
export interface FakeChartEntry {
  id: string;
  name: string;
  artistName: string;
}

/** A GIF or sticker in the fake KLIPY. `host` overrides the media host (default static.klipy.com). */
export interface FakeGif {
  kind: 'gif' | 'sticker';
  title: string;
  host?: string;
}

export const KLIPY_TEST_KEY = 'klipy-test-key';

const isoDuration = (sec: number) =>
  `PT${Math.floor(sec / 3600)}H${Math.floor((sec % 3600) / 60)}M${sec % 60}S`;

export interface HarnessOptions {
  hostGraceMs?: number;
  emptyTtlMs?: number;
  /** Turns on the per-address REST and per-user socket limits (off by default: tests share one IP). */
  rateLimits?: boolean;
  /** Refuse browser requests from other origins, as `APP_URL` does in production. */
  allowedOrigin?: string;
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
  /** The `regionCode` each search asked for ('' for none). */
  const searchRegions: string[] = [];
  /** Canned `playlistItems.list` data: playlist id -> video ids; an absent id answers 404. */
  const playlistPages = new Map<string, string[]>();
  /** Fake Deezer: songs by id, `/search/track` answers (query -> ids), and the paths asked for. */
  const catalogSongs = new Map<string, FakeSong>();
  const catalogSearch = new Map<string, string[]>();
  const catalogCalls: string[] = [];
  /** Fake Odesli: Deezer id -> linked videos by platform; unknown ids answer 404. */
  const songLinks = new Map<string, { youtubeMusic?: string; youtube?: string }>();
  const songLinkCalls: string[] = [];
  /** Fake MusicBrainz: ISRC -> the URLs related to its recording; unknown ISRCs answer 404. */
  const musicBrainz = new Map<string, string[]>();
  const musicBrainzCalls: string[] = [];
  /** Fake Apple Music charts by country (lowercase); others answer 404. And Deezer's own chart. */
  const appleCharts = new Map<string, FakeChartEntry[]>();
  const appleChartCalls: string[] = [];
  const deezerChart: string[] = [];
  /** Fake Deezer playlists: id -> song ids (unknown ids answer "not found"); and playlist search. */
  const deezerPlaylists = new Map<string, string[]>();
  const deezerPlaylistSearch = new Map<string, { id: number; user: { name: string } }[]>();
  /** Fake Deezer artist radios: artist id -> song ids; unknown artists answer "not found". */
  const artistRadios = new Map<string, string[]>();
  /** Set to make Deezer answer with this error code (status 200, like the real one). */
  const deezer: { errorCode: number | null } = { errorCode: null };
  const deezerTrack = (id: string, song: FakeSong) => ({
    id: Number(id),
    readable: song.readable ?? true,
    isrc: song.isrc,
    title: song.title,
    duration: song.durationSec,
    rank: song.rank,
    artist: {
      ...(song.artistId === undefined ? {} : { id: Number(song.artistId) }),
      name: song.artist,
    },
    album: {
      title: song.album ?? `${song.title} (Single)`,
      cover_medium: `https://cdn-images.dzcdn.net/images/cover/${id}/250x250.jpg`,
    },
  });
  /** Fake KLIPY: items by slug, the paths asked for, and an optional forced HTTP status. */
  const klipyItems = new Map<string, FakeGif>();
  const klipyCalls: string[] = [];
  const klipy: { status: number | null } = { status: null };
  const klipyItem = (slug: string, gif: FakeGif) => {
    const base = `https://${gif.host ?? 'static.klipy.com'}/${slug}`;
    return {
      id: slug.length,
      slug,
      title: gif.title,
      type: gif.kind,
      file: {
        md: { webp: { url: `${base}/md.webp`, width: 220, height: 160, size: 1000 } },
        sm: { webp: { url: `${base}/sm.webp`, width: 110, height: 80, size: 500 } },
      },
    };
  };
  const klipyAnswer = (url: URL) => {
    klipyCalls.push(`${url.pathname}${url.search}`);
    if (klipy.status !== null) return new Response('{}', { status: klipy.status });
    const [, , , key, kinds, action] = url.pathname.split('/');
    if (key !== KLIPY_TEST_KEY) return new Response('{}', { status: 401 });
    const kind = kinds === 'stickers' ? 'sticker' : 'gif';
    const q = url.searchParams.get('q') ?? '';
    const slugs = url.searchParams.get('slugs')?.split(',');
    const items = [...klipyItems]
      .filter(([slug, gif]) => {
        if (gif.kind !== kind) return false;
        if (action === 'items') return slugs?.includes(slug) ?? false;
        return action === 'trending' || gif.title.toLowerCase().includes(q);
      })
      .map(([slug, gif]) => klipyItem(slug, gif));
    // Ads come mixed into real answers and must be skipped.
    const data = [{ type: 'ad', content: '<div></div>', width: 300, height: 250 }, ...items];
    return Response.json({ result: true, data: { data, current_page: 1, has_next: false } });
  };
  /** Fake Last.fm: "artist|title" (lowercase) -> similar songs; unknown songs answer "not found". */
  const lastfmSimilar = new Map<string, { title: string; artist: string; match: number }[]>();
  const lastfmCalls: string[] = [];
  const fakeFetch = (async (input: URL | string) => {
    const url = new URL(input);
    if (url.hostname === 'api.klipy.com') return klipyAnswer(url);
    if (url.hostname === 'rss.marketingtools.apple.com') {
      const country = url.pathname.split('/')[3] ?? '';
      appleChartCalls.push(country);
      const entries = appleCharts.get(country);
      if (!entries) return new Response('Not Found', { status: 404 });
      return Response.json({ feed: { country, results: entries } });
    }
    if (url.hostname === 'ws.audioscrobbler.com') {
      const asked =
        `${url.searchParams.get('artist')}|${url.searchParams.get('track')}`.toLowerCase();
      lastfmCalls.push(asked);
      const found = lastfmSimilar.get(asked);
      if (!found) return Response.json({ error: 6, message: 'Track not found' });
      return Response.json({
        similartracks: {
          track: found.map((s) => ({ name: s.title, match: s.match, artist: { name: s.artist } })),
        },
      });
    }
    if (url.hostname === 'musicbrainz.org') {
      const isrc = url.pathname.split('/').pop() ?? '';
      musicBrainzCalls.push(isrc);
      const urls = musicBrainz.get(isrc);
      if (!urls) return Response.json({ error: 'Not Found' }, { status: 404 });
      const relations = urls.map((resource) => ({ type: 'free streaming', url: { resource } }));
      return Response.json({ isrc, recordings: [{ relations }] });
    }
    if (url.hostname === 'api.song.link') {
      const id = (url.searchParams.get('url') ?? '').split('/').pop() ?? '';
      songLinkCalls.push(id);
      const links = songLinks.get(id);
      if (!links) return Response.json({ statusCode: 404 }, { status: 404 });
      const linksByPlatform = Object.fromEntries(
        Object.entries(links).map(([platform, videoId]) => [
          platform,
          {
            url:
              platform === 'youtubeMusic'
                ? `https://music.youtube.com/watch?v=${videoId}`
                : `https://www.youtube.com/watch?v=${videoId}`,
          },
        ]),
      );
      return Response.json({ linksByPlatform });
    }
    if (url.hostname === 'api.deezer.com') {
      catalogCalls.push(`${url.pathname}${url.search}`);
      if (deezer.errorCode !== null) {
        return Response.json({ error: { code: deezer.errorCode, message: 'Deezer error' } });
      }
      if (url.pathname === '/chart/0/tracks') {
        return Response.json({
          data: deezerChart.flatMap((id) => {
            const song = catalogSongs.get(id);
            return song ? [deezerTrack(id, song)] : [];
          }),
        });
      }
      const playlist = /^\/playlist\/(\d+)\/tracks$/.exec(url.pathname);
      if (playlist) {
        const ids = deezerPlaylists.get(playlist[1]!);
        if (!ids) return Response.json({ error: { code: 800 } });
        return Response.json({
          data: ids.flatMap((id) => {
            const song = catalogSongs.get(id);
            return song ? [deezerTrack(id, song)] : [];
          }),
        });
      }
      if (url.pathname === '/search/playlist') {
        return Response.json({
          data: deezerPlaylistSearch.get(url.searchParams.get('q') ?? '') ?? [],
        });
      }
      const radio = /^\/artist\/(\d+)\/radio$/.exec(url.pathname);
      if (radio) {
        const ids = artistRadios.get(radio[1]!);
        if (!ids) return Response.json({ error: { code: 800 } });
        return Response.json({
          data: ids.flatMap((id) => {
            const song = catalogSongs.get(id);
            return song ? [deezerTrack(id, song)] : [];
          }),
        });
      }
      if (url.pathname === '/search/track') {
        const ids = catalogSearch.get(url.searchParams.get('q') ?? '') ?? [];
        return Response.json({
          data: ids.flatMap((id) => {
            const song = catalogSongs.get(id);
            return song ? [deezerTrack(id, song)] : [];
          }),
        });
      }
      const id = url.pathname.replace('/track/', '');
      const song = catalogSongs.get(id);
      return Response.json(song ? deezerTrack(id, song) : { error: { code: 800 } });
    }
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
      searchRegions.push(url.searchParams.get('regionCode') ?? '');
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
                channelTitle: v.channelTitle ?? 'Test Channel',
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
  const metrics = createMetrics(redis);
  const catalog = createCatalogService({ redis, settings, fetch: fakeFetch });
  const youtube = createYouTubeService({
    apiKey: 'test-key',
    tracks: createTrackStore(db),
    quota: quotaStore,
    region: () => settings.get('search.region'),
    fetch: fakeFetch,
  });
  const catalogMatches = createCatalogMatchStore(db);
  const search = createSearchService({
    redis,
    settings,
    quota: quotaStore,
    youtube,
    catalog,
    matches: catalogMatches,
    songLinks: [
      createOdesliLinks({ redis, apiKey: 'odesli-key', fetch: fakeFetch }),
      createMusicBrainzLinks({
        redis,
        isrc: catalog.isrc,
        userAgent: 'Spotibay/test',
        fetch: fakeFetch,
      }),
    ],
    metrics,
  });
  const recommendations = createRecommendationService({
    db,
    redis,
    catalog,
    settings,
    similar: createLastfmSimilar({ redis, apiKey: 'test-lastfm-key', fetch: fakeFetch }),
  });
  const vibes = createVibeService({ db, catalog, matches: catalogMatches, settings });
  const playback = createPlaybackService({
    store: playbackStore,
    queue: createQueueStore(db),
    youtube,
    presence,
    rooms,
    settings,
  });
  const autoplay = createAutoplayService({
    playback,
    rooms,
    presence,
    recommendations,
    matcher: search,
    settings,
    metrics,
  });
  const gifs = createGifService({ redis, settings, apiKey: KLIPY_TEST_KEY, fetch: fakeFetch });
  const chat = createChatService({
    store: createChatStore(db),
    redis,
    settings,
    gifs,
    members: (roomId) => presence.list(roomId),
  });
  const playlists = createPlaylistService({ db, youtube, settings });
  const library = createLibraryService({ db });
  const lifecycle = createRoomLifecycle({
    rooms,
    presence,
    hostGraceMs: options.hostGraceMs,
    emptyTtlMs: options.emptyTtlMs,
  });
  const adminAuth = createAdminAuth({
    store: createAdminStore(db),
    jwtSecret: 'j'.repeat(40),
    username: ADMIN_USERNAME,
    passwordHash: await hashPassword(ADMIN_PASSWORD),
  });
  await adminAuth.sync();
  const adminService = createAdminService({
    store: createAdminDataStore(db),
    audit: createAuditService(createAuditStore(db)),
    rooms,
    presence,
    playback,
    chat,
    settings,
    metrics,
  });
  const app = createApp({
    admin: { auth: adminAuth, service: adminService, redis, settings },
    identity,
    bans,
    rooms,
    presence,
    playback,
    search,
    recommendations,
    vibes,
    gifs,
    playlists,
    library,
    limits: options.rateLimits ? { redis, settings } : undefined,
    allowedOrigin: options.allowedOrigin,
    secureCookie: false,
  });
  const httpServer: Server = createServer(app);
  const io = createSocketServer({
    admin: { auth: adminAuth, service: adminService, settings },
    httpServer,
    identity,
    bans,
    rooms,
    presence,
    lifecycle,
    playback,
    chat,
    playlists,
    maxUsersPerRoom: () => settings.get('limits.maxUsersPerRoom'),
    queueLimitPerUser: () => settings.get('limits.maxQueueItemsPerUser'),
    eventLimit: options.rateLimits
      ? { redis, perSecond: () => settings.get('limits.socketEventsPerSecond') }
      : undefined,
    passwordAttempts: { redis },
    allowedOrigin: options.allowedOrigin,
    syncConfig: () => ({
      driftThresholdMs: settings.get('sync.driftThresholdMs'),
      checkIntervalMs: settings.get('sync.checkIntervalMs'),
    }),
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  const sockets = new Set<ClientSocket>();

  function connect(cookie: string, headers: Record<string, string> = {}): ClientSocket {
    const socket: ClientSocket = connectClient(baseUrl, {
      transports: ['websocket'],
      extraHeaders: { cookie, ...headers },
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

  /** Signs in as the admin; `ip` varies the address the login rate limit sees. */
  async function admin(ip = '203.0.113.1') {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    });
    if (res.status !== 200) throw new Error(`admin login failed: ${res.status}`);
    const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;

    async function api<T = unknown>(method: string, path: string, body?: unknown) {
      const r = await fetch(`${baseUrl}/api/admin${path}`, {
        method,
        headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json().catch(() => null)) as T };
    }

    return { cookie, api };
  }

  /** A client on the `/admin` namespace. */
  function adminNamespace(cookie: string) {
    const socket = connectNamespace(`${baseUrl}/admin`, {
      transports: ['websocket'],
      extraHeaders: { cookie },
      reconnection: false,
    });
    sockets.add(socket as unknown as ClientSocket);
    return socket;
  }

  async function close() {
    lifecycle.stop();
    autoplay.stop();
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
    catalogSongs,
    catalogSearch,
    catalogCalls,
    deezer,
    appleCharts,
    appleChartCalls,
    deezerChart,
    lastfmSimilar,
    lastfmCalls,
    deezerPlaylists,
    deezerPlaylistSearch,
    artistRadios,
    recommendations,
    autoplay,
    searchRegions,
    songLinks,
    songLinkCalls,
    musicBrainz,
    musicBrainzCalls,
    metrics,
    klipyItems,
    klipyCalls,
    klipy,
    youtube,
    quota: quotaStore,
    guest,
    admin,
    adminNamespace,
    adminPassword: ADMIN_PASSWORD,
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
