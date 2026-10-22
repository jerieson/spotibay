import { createServer } from 'node:http';
import { createApp } from './app.js';
import { db, pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { env } from './env.js';
import { connectRedis, redis } from './redis.js';
import { createIdentityService } from './services/identity.js';
import { createPresence } from './services/presence.js';
import { createRoomLifecycle } from './services/room-lifecycle.js';
import { createRoomService } from './services/rooms.js';
import { settings } from './services/settings.js';
import { createBanStore, createRoomStore, createUserStore } from './services/user-store.js';
import { createSocketServer } from './socket/server.js';

await runMigrations();
await connectRedis();
await settings.load();

const identity = createIdentityService(createUserStore(db), {
  jwtSecret: env.JWT_SECRET,
  recoveryHmacSecret: env.RECOVERY_HMAC_SECRET,
});
const bans = createBanStore(db);
const presence = createPresence(redis);
const rooms = createRoomService({ store: createRoomStore(db), presence, settings });
const lifecycle = createRoomLifecycle({ rooms, presence });

const app = createApp({
  checks: {
    db: () => pool.query('select 1'),
    redis: () => redis.ping(),
  },
  identity,
  bans,
  rooms,
  wordFilter: () => settings.get('moderation.wordFilter'),
  secureCookie: env.NODE_ENV === 'production',
});

const httpServer = createServer(app);
createSocketServer({
  httpServer,
  identity,
  bans,
  rooms,
  presence,
  lifecycle,
  maxUsersPerRoom: () => settings.get('limits.maxUsersPerRoom'),
});
await lifecycle.start();

httpServer.listen(env.PORT, () => {
  console.log(`api listening on :${env.PORT}`);
});
