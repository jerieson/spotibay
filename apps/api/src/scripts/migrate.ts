import { pool } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

await runMigrations();
await pool.end();
console.log('migrations applied');
