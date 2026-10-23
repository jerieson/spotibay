import type { RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { hit } from '../lib/rate-limit.js';
import { logger } from '../logger.js';

export interface RateLimitOptions {
  redis: Redis;
  /** Counter namespace in Redis (`ratelimit:{name}:{ip}`). */
  name: string;
  /** Read per request so admin changes apply live. */
  limit: () => number;
  windowSec: number;
}

/** Per-address fixed-window limit. A Redis failure lets the request through rather than taking the api down. */
export function rateLimit({ redis, name, limit, windowSec }: RateLimitOptions): RequestHandler {
  return async (req, res, next) => {
    try {
      const allowed = await hit(redis, `ratelimit:${name}:${req.ip ?? 'unknown'}`, limit(), windowSec);
      if (!allowed) {
        res.setHeader('Retry-After', String(windowSec));
        res.status(429).json({ error: 'rate_limited', message: 'Too many requests, slow down' });
        return;
      }
    } catch (err) {
      logger.error({ err }, 'rate limit check failed');
    }
    next();
  };
}
