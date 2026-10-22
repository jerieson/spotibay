import express, { type ErrorRequestHandler } from 'express';
import type { HealthResponse } from '@spotibay/shared';
import { attachUser, banGuard } from './middleware/session.js';
import { createRoomsRouter } from './routes/rooms.js';
import { createSearchRouter } from './routes/search.js';
import { createSessionRouter } from './routes/session.js';
import type { BanStore } from './services/bans.js';
import type { IdentityService } from './services/identity.js';
import type { RoomService } from './services/rooms.js';
import type { SearchService } from './services/search.js';

export interface HealthChecks {
  db: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}

export interface AppDeps {
  checks?: HealthChecks;
  /** Identity routes, session middleware and ban checks are mounted only when these are provided. */
  identity?: IdentityService;
  bans?: BanStore;
  wordFilter?: () => readonly string[];
  /** Room routes are mounted when this is provided (requires `identity`). */
  rooms?: RoomService;
  /** Search route is mounted when this is provided (requires `identity`). */
  search?: SearchService;
  secureCookie?: boolean;
}

async function probe(check: () => Promise<unknown>): Promise<'ok' | 'error'> {
  try {
    await check();
    return 'ok';
  } catch {
    return 'error';
  }
}

const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
    res.status(400).json({ error: 'invalid_request', message: 'Malformed JSON' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
};

export function createApp({
  checks,
  identity,
  bans,
  wordFilter,
  rooms,
  search,
  secureCookie = true,
}: AppDeps = {}) {
  const app = express();
  // Caddy is the single trusted proxy in front of the api.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.get('/api/health', async (_req, res) => {
    const body: HealthResponse = { status: 'ok' };
    if (checks) {
      const [db, redis] = await Promise.all([probe(checks.db), probe(checks.redis)]);
      body.db = db;
      body.redis = redis;
      if (db === 'error' || redis === 'error') body.status = 'error';
    }
    res.status(body.status === 'ok' ? 200 : 503).json(body);
  });

  if (identity && bans) {
    app.use('/api', express.json({ limit: '16kb' }));
    app.use('/api', attachUser(identity, secureCookie), banGuard(bans));
    app.use(
      '/api',
      createSessionRouter({ identity, wordFilter: wordFilter ?? (() => []), secureCookie }),
    );
    if (rooms) app.use('/api', createRoomsRouter({ rooms }));
    if (search) app.use('/api', createSearchRouter({ search }));
  }

  app.use(errorHandler);
  return app;
}
