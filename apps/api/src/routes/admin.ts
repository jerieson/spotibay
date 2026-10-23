import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import {
  ADMIN_COOKIE,
  ADMIN_LOGIN_LIMIT,
  ADMIN_LOGIN_WINDOW_SEC,
  ADMIN_SESSION_MAX_AGE_SEC,
  adminBanQuerySchema,
  adminChatQuerySchema,
  adminLoginBodySchema,
  adminSettingUpdateBodySchema,
  adminUserQuerySchema,
  auditQuerySchema,
  createBanBodySchema,
  isSettingKey,
  kickBodySchema,
  roomCodeSchema,
  type AdminBan,
} from '@spotibay/shared';
import { hit } from '../lib/rate-limit.js';
import { validateBody, validateQuery } from '../lib/validate.js';
import { readCookie } from '../middleware/session.js';
import type { AdminAuth, AdminRecord } from '../services/admin-auth.js';
import { AdminError, type AdminService } from '../services/admin.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's documented augmentation point
  namespace Express {
    interface Request {
      admin?: AdminRecord;
    }
  }
}

export interface AdminRouterDeps {
  auth: AdminAuth;
  admin: AdminService;
  redis: Redis;
  secureCookie: boolean;
}

const uuidSchema = z.uuid();

/** Resolves the admin cookie to `req.admin`; used by the router and by the maintenance gate. */
export function attachAdmin(auth: AdminAuth): RequestHandler {
  return async (req, _res, next) => {
    try {
      req.admin = (await auth.verify(readCookie(req.headers.cookie, ADMIN_COOKIE))) ?? undefined;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function createAdminRouter({ auth, admin, redis, secureCookie }: AdminRouterDeps) {
  const router = Router();

  const statusByCode = { not_found: 404, invalid_request: 400 } as const;
  /** Maps domain errors to responses; anything else reaches the app's error handler. */
  const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res, next: NextFunction) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof AdminError) {
          res.status(statusByCode[err.code]).json({ error: err.code, message: err.message });
          return;
        }
        next(err);
      }
    };

  router.post('/login', validateBody(adminLoginBodySchema), async (req, res) => {
    if (!auth.enabled) {
      res.status(503).json({ error: 'admin_disabled', message: 'The admin panel is not set up' });
      return;
    }
    const allowed = await hit(
      redis,
      `ratelimit:adminlogin:${req.ip ?? 'unknown'}`,
      ADMIN_LOGIN_LIMIT,
      ADMIN_LOGIN_WINDOW_SEC,
    );
    if (!allowed) {
      res
        .status(429)
        .json({ error: 'rate_limited', message: 'Too many attempts, try again later' });
      return;
    }
    const session = await auth.login(req.body.username, req.body.password);
    if (!session) {
      res.status(401).json({ error: 'invalid_credentials', message: 'Wrong username or password' });
      return;
    }
    res.cookie(ADMIN_COOKIE, session.token, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'strict',
      maxAge: ADMIN_SESSION_MAX_AGE_SEC * 1000,
      path: '/',
    });
    res.json({ admin: { username: session.admin.username } });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(ADMIN_COOKIE, { path: '/' });
    res.status(204).end();
  });

  router.use(attachAdmin(auth));
  router.use((req, res, next) => {
    if (!req.admin) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    next();
  });
  const adminId = (req: Request) => req.admin!.id;

  router.get('/me', (req, res) => {
    res.json({ admin: { username: req.admin!.username } });
  });

  router.get(
    '/stats',
    handle(async (_req, res) => void res.json(await admin.stats())),
  );

  router.get('/settings', (_req, res) => {
    res.json(admin.getSettings());
  });

  router.put(
    '/settings/:key',
    validateBody(adminSettingUpdateBodySchema),
    handle(async (req, res) => {
      const key = String(req.params.key);
      if (!isSettingKey(key)) throw new AdminError('not_found', 'Unknown setting');
      const change = await admin.updateSetting(adminId(req), key, req.body.value);
      res.json({ key, value: change.value, version: change.version });
    }),
  );

  router.get(
    '/rooms',
    handle(async (_req, res) => void res.json({ rooms: await admin.listRooms() })),
  );

  router.param('code', (req, res, next, raw: string) => {
    const parsed = roomCodeSchema.safeParse(raw);
    if (!parsed.success) {
      res.status(404).json({ error: 'not_found', message: 'Room not found' });
      return;
    }
    req.params.code = parsed.data;
    next();
  });

  router.get(
    '/rooms/:code',
    handle(
      async (req, res) => void res.json({ room: await admin.getRoom(String(req.params.code)) }),
    ),
  );

  router.post(
    '/rooms/:code/close',
    handle(async (req, res) => {
      await admin.closeRoom(adminId(req), String(req.params.code));
      res.status(204).end();
    }),
  );

  router.post(
    '/rooms/:code/kick',
    validateBody(kickBodySchema),
    handle(async (req, res) => {
      await admin.kick(adminId(req), String(req.params.code), req.body.userId);
      res.status(204).end();
    }),
  );

  router.get(
    '/users',
    validateQuery(adminUserQuerySchema),
    handle(async (_req, res) => {
      const { q } = res.locals.query as z.infer<typeof adminUserQuerySchema>;
      res.json({ users: await admin.listUsers(q) });
    }),
  );

  router.get(
    '/users/:id',
    handle(async (req, res) => {
      const id = uuidSchema.safeParse(req.params.id);
      if (!id.success) throw new AdminError('not_found', 'User not found');
      res.json({ user: await admin.getUser(id.data) });
    }),
  );

  router.get(
    '/bans',
    validateQuery(adminBanQuerySchema),
    handle(async (_req, res) => {
      const { includeExpired } = res.locals.query as z.infer<typeof adminBanQuerySchema>;
      res.json({ bans: await admin.listBans({ includeExpired }) });
    }),
  );

  router.post(
    '/bans',
    validateBody(createBanBodySchema),
    handle(async (req, res) => {
      const ban: AdminBan = await admin.ban(adminId(req), req.body);
      res.status(201).json({ ban });
    }),
  );

  router.delete(
    '/bans/:id',
    handle(async (req, res) => {
      const id = z.coerce.number().int().positive().safeParse(req.params.id);
      if (!id.success) throw new AdminError('not_found', 'No active ban with that id');
      res.json({ ban: await admin.unban(adminId(req), id.data) });
    }),
  );

  router.get(
    '/chat',
    validateQuery(adminChatQuerySchema),
    handle(async (_req, res) => {
      const query = res.locals.query as z.infer<typeof adminChatQuerySchema>;
      res.json({ messages: await admin.listChat(query) });
    }),
  );

  router.delete(
    '/chat/:id',
    handle(async (req, res) => {
      const id = uuidSchema.safeParse(req.params.id);
      if (!id.success) throw new AdminError('not_found', 'Message not found');
      await admin.deleteMessage(adminId(req), id.data);
      res.status(204).end();
    }),
  );

  router.get(
    '/quota',
    handle(async (_req, res) => void res.json(await admin.quota())),
  );

  router.get(
    '/audit',
    validateQuery(auditQuerySchema),
    handle(async (_req, res) => {
      const query = res.locals.query as z.infer<typeof auditQuerySchema>;
      res.json(await admin.listAudit(query));
    }),
  );

  // Keeps unknown admin paths from falling through to the guest routes.
  router.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return router;
}
