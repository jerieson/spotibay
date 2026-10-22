import { createApp } from './app.js';
import { db, pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { env } from './env.js';
import { connectRedis, redis } from './redis.js';
import { createIdentityService } from './services/identity.js';
import { settings } from './services/settings.js';
import { createBanStore, createUserStore } from './services/user-store.js';

await runMigrations();
await connectRedis();
await settings.load();

const app = createApp({
  checks: {
    db: () => pool.query('select 1'),
    redis: () => redis.ping(),
  },
  identity: createIdentityService(createUserStore(db), {
    jwtSecret: env.JWT_SECRET,
    recoveryHmacSecret: env.RECOVERY_HMAC_SECRET,
  }),
  bans: createBanStore(db),
  wordFilter: () => settings.get('moderation.wordFilter'),
  secureCookie: env.NODE_ENV === 'production',
});

app.listen(env.PORT, () => {
  console.log(`api listening on :${env.PORT}`);
});
