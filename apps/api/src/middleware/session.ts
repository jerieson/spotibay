import type { RequestHandler, Response } from 'express';
import { SESSION_COOKIE, SESSION_MAX_AGE_SEC } from '@spotibay/shared';
import type { BanStore } from '../services/bans.js';
import type { IdentityService, UserRecord } from '../services/identity.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's documented augmentation point
  namespace Express {
    interface Request {
      user?: UserRecord;
    }
  }
}

const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_SEC * 1000,
    path: '/',
  });
}

/** Resolves the session cookie to `req.user` (if valid) and refreshes the cookie once it is a day old. */
export function attachUser(identity: IdentityService, secureCookie: boolean): RequestHandler {
  return async (req, res, next) => {
    try {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      const claims = token ? await identity.verifySession(token) : null;
      const user = claims ? await identity.getUser(claims.userId) : null;
      if (claims && user) {
        req.user = user;
        if (Date.now() - claims.issuedAt.getTime() > REFRESH_AFTER_MS) {
          setSessionCookie(res, await identity.signSession(user.id), secureCookie);
          await identity.touch(user.id);
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function banGuard(bans: BanStore): RequestHandler {
  return async (req, res, next) => {
    try {
      const user = req.user;
      let reason: string | null = null;
      let until: Date | null = null;
      let banned = false;
      if (user?.bannedUntil && user.bannedUntil.getTime() > Date.now()) {
        banned = true;
        until = user.bannedUntil;
      } else {
        const ban = await bans.findActiveBan({ userId: user?.id, ip: req.ip });
        if (ban) {
          banned = true;
          reason = ban.reason;
          until = ban.expiresAt;
        }
      }
      if (banned) {
        res.status(403).json({ error: 'banned', reason, until: until?.toISOString() ?? null });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireUser: RequestHandler = (req, res, next) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  next();
};
