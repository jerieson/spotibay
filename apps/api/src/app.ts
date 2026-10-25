import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import type { HealthResponse, SiteResponse } from '@spotibay/shared';
import { logger } from './logger.js';
import { originGuard } from './middleware/origin.js';
import { rateLimit } from './middleware/rate-limit.js';
import { attachUser, banGuard } from './middleware/session.js';
import { attachAdmin, createAdminRouter } from './routes/admin.js';
import { createLibraryRouter } from './routes/library.js';
import { createRoomsRouter } from './routes/rooms.js';
import { createSearchRouter } from './routes/search.js';
import { createSessionRouter } from './routes/session.js';
import type { AdminAuth } from './services/admin-auth.js';
import type { AdminService } from './services/admin.js';
import type { BanStore } from './services/bans.js';
import type { IdentityService } from './services/identity.js';
import type { LibraryService } from './services/library.js';
import type { PlaybackService } from './services/playback.js';
import type { PlaylistService } from './services/playlists.js';
import type { Presence } from './services/presence.js';
import type { RoomService } from './services/rooms.js';
import type { SearchService } from './services/search.js';
import type { SettingsService } from './services/settings.js';

export interface HealthChecks {
  db: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}

export interface AdminDeps {
  auth: AdminAuth;
  service: AdminService;
  redis: Redis;
  settings: Pick<SettingsService, 'get'>;
}

export interface AppDeps {
  checks?: HealthChecks;
  /** Identity routes, session middleware and ban checks are mounted only when these are provided. */
  identity?: IdentityService;
  bans?: BanStore;
  wordFilter?: () => readonly string[];
  /** Room routes are mounted when this is provided (requires `identity`). */
  rooms?: RoomService;
  /** With `rooms`, enables the room history route. */
  presence?: Presence;
  playback?: Pick<PlaybackService, 'history'>;
  /** Search route is mounted when this is provided (requires `identity`). */
  search?: SearchService;
  /** Playlist, likes and listening-history routes are mounted when both are provided. */
  playlists?: PlaylistService;
  library?: LibraryService;
  /** Admin routes, `/api/site` and the maintenance gate are mounted when this is provided. */
  admin?: AdminDeps;
  /** Per-address REST limits, read live from settings; enabled when provided. */
  limits?: { redis: Redis; settings: Pick<SettingsService, 'get'> };
  /** The site's own origin (from `APP_URL`); unsafe requests from other origins are refused when set. */
  allowedOrigin?: string;
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
  logger.error({ err }, 'unhandled request error');
  res.status(500).json({ error: 'internal_error' });
};

export function createApp({
  checks,
  identity,
  bans,
  wordFilter,
  rooms,
  presence,
  playback,
  search,
  playlists,
  library,
  admin,
  limits,
  allowedOrigin,
  secureCookie = true,
}: AppDeps = {}) {
  const app = express();
  // Caddy is the single trusted proxy in front of the api.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use('/api', (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/health') return;
      logger.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
        },
        'request',
      );
    });
    next();
  });

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

  if (allowedOrigin) app.use('/api', originGuard(allowedOrigin));

  if (limits) {
    const { redis, settings } = limits;
    app.use(
      '/api',
      rateLimit({
        redis,
        name: 'rest',
        limit: () => settings.get('limits.requestsPerMinute'),
        windowSec: 60,
      }),
    );
    // Creating accounts, rooms and imports is the costly part; cap it harder than plain reads.
    app.post(
      ['/api/session', '/api/session/recover', '/api/rooms', '/api/playlists/import'],
      rateLimit({
        redis,
        name: 'expensive',
        limit: () => settings.get('limits.expensiveRequestsPerMinute'),
        windowSec: 60,
      }),
    );
  }

  if ((identity && bans) || admin) app.use('/api', express.json({ limit: '16kb' }));

  if (admin) {
    const { settings } = admin;
    app.get('/api/site', (_req, res) => {
      const body: SiteResponse = {
        maintenance: settings.get('site.maintenanceMode'),
        announcement: settings.get('site.announcement'),
      };
      res.json(body);
    });
    app.use(
      '/api/admin',
      createAdminRouter({
        auth: admin.auth,
        admin: admin.service,
        redis: admin.redis,
        secureCookie,
      }),
    );
    const maintenanceGate: RequestHandler = (req, res, next) => {
      if (settings.get('site.maintenanceMode') && !req.admin) {
        res.status(503).json({ error: 'maintenance', message: 'Spotibay is down for maintenance' });
        return;
      }
      next();
    };
    app.use('/api', attachAdmin(admin.auth), maintenanceGate);
  }

  if (identity && bans) {
    app.use('/api', attachUser(identity, secureCookie), banGuard(bans));
    app.use(
      '/api',
      createSessionRouter({ identity, wordFilter: wordFilter ?? (() => []), secureCookie }),
    );
    if (rooms) app.use('/api', createRoomsRouter({ rooms, presence, playback }));
    if (search) app.use('/api', createSearchRouter({ search }));
    if (playlists && library) {
      app.use('/api', createLibraryRouter({ playlists, library, rooms, presence, playback }));
    }
  }

  app.use(errorHandler);
  return app;
}
