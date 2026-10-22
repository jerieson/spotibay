import { createApp } from './app.js';
import { pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { env } from './env.js';
import { connectRedis, redis } from './redis.js';
import { settings } from './services/settings.js';

await runMigrations();
await connectRedis();
await settings.load();

const app = createApp({
  db: () => pool.query('select 1'),
  redis: () => redis.ping(),
});

app.listen(env.PORT, () => {
  console.log(`api listening on :${env.PORT}`);
});
