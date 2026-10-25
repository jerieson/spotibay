import { createServer } from 'node:http';
import { createApp } from './app.js';
import { db, pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { connectRedis, redis } from './redis.js';
import { createAdminAuth } from './services/admin-auth.js';
import { createAdminService } from './services/admin.js';
import {
  createAdminDataStore,
  createAdminStore,
  createAuditStore,
} from './services/admin-store.js';
import { createAuditService } from './services/audit.js';
import { createChatService } from './services/chat.js';
import { createChatStore } from './services/chat-store.js';
import { createLibraryService } from './services/library.js';
import { createIdentityService } from './services/identity.js';
import { createPlaylistService } from './services/playlists.js';
import { createPresence } from './services/presence.js';
import { createPlaybackService } from './services/playback.js';
import { createPlaybackStore } from './services/playback-store.js';
import { createQueueStore, createQuotaStore, createTrackStore } from './services/queue-store.js';
import { createRoomLifecycle } from './services/room-lifecycle.js';
import { createRoomService } from './services/rooms.js';
import { createSearchService } from './services/search.js';
import { settings } from './services/settings.js';
import { createBanStore, createRoomStore, createUserStore } from './services/user-store.js';
import { createLookupCharger, createYouTubeService } from './services/youtube.js';
import { createSocketServer } from './socket/server.js';

const allowedOrigin = env.APP_URL ? new URL(env.APP_URL).origin : undefined;
if (!allowedOrigin && env.NODE_ENV === 'production') {
  logger.warn('APP_URL is not set; requests from other sites are not refused');
}

await runMigrations();
await connectRedis();
await settings.load();

const identity = createIdentityService(createUserStore(db), {
  jwtSecret: env.JWT_SECRET,
  recoveryHmacSecret: env.RECOVERY_HMAC_SECRET,
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
const quotaStore = createQuotaStore(db);
const youtube = createYouTubeService({
  apiKey: env.YOUTUBE_API_KEY,
  tracks: createTrackStore(db),
  quota: quotaStore,
  chargeLookup: createLookupCharger(redis, () => settings.get('limits.videoLookupsPerUserPerDay')),
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
const chat = createChatService({ store: createChatStore(db), redis, settings });
const playlists = createPlaylistService({ db, youtube, settings });
const library = createLibraryService({ db });
const lifecycle = createRoomLifecycle({ rooms, presence });
const adminAuth = createAdminAuth({
  store: createAdminStore(db),
  jwtSecret: env.JWT_SECRET,
  username: env.ADMIN_USERNAME,
  passwordHash: env.ADMIN_PASSWORD_HASH,
});
await adminAuth.sync();
if (!adminAuth.enabled) logger.warn('ADMIN_PASSWORD_HASH is not set; the admin panel is disabled');
const adminService = createAdminService({
  store: createAdminDataStore(db),
  audit: createAuditService(createAuditStore(db)),
  rooms,
  presence,
  playback,
  chat,
  settings,
});

const app = createApp({
  checks: {
    db: () => pool.query('select 1'),
    redis: () => redis.ping(),
  },
  identity,
  bans,
  rooms,
  presence,
  playback,
  search,
  playlists,
  library,
  admin: { auth: adminAuth, service: adminService, redis, settings },
  limits: { redis, settings },
  wordFilter: () => settings.get('moderation.wordFilter'),
  allowedOrigin,
  secureCookie: env.NODE_ENV === 'production',
});

const httpServer = createServer(app);
const io = createSocketServer({
  httpServer,
  identity,
  bans,
  rooms,
  presence,
  lifecycle,
  playback,
  chat,
  playlists,
  admin: { auth: adminAuth, service: adminService, settings },
  maxUsersPerRoom: () => settings.get('limits.maxUsersPerRoom'),
  eventLimit: { redis, perSecond: () => settings.get('limits.socketEventsPerSecond') },
  passwordAttempts: { redis },
  allowedOrigin,
  syncConfig: () => ({
    driftThresholdMs: settings.get('sync.driftThresholdMs'),
    checkIntervalMs: settings.get('sync.checkIntervalMs'),
  }),
});
await lifecycle.start();
await playback.start();

httpServer.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'api listening');
});

const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

/** Playback state lives in Redis on every change, so stopping the timers is enough: `playback.start()` re-arms them on boot. */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => {
    logger.error('shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();
  try {
    playback.stop();
    lifecycle.stop();
    // Closes the http server too, so no new connections arrive while sockets drain.
    await io.close();
    await Promise.all([pool.end(), redis.quit()]);
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
