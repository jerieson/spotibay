import type { RequestHandler } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Browsers send `Origin` on cross-site and state-changing requests. A missing header is not a
 * browser acting for someone on another site, so only a present, different origin is refused.
 */
export function isAllowedOrigin(origin: string | undefined, allowed: string): boolean {
  return origin === undefined || origin === allowed;
}

/** Refuses state-changing requests made by pages on other origins, including sibling subdomains. */
export function originGuard(allowed: string): RequestHandler {
  return (req, res, next) => {
    if (!SAFE_METHODS.has(req.method) && !isAllowedOrigin(req.headers.origin, allowed)) {
      res.status(403).json({ error: 'forbidden_origin', message: 'Request from another site' });
      return;
    }
    next();
  };
}
