import type { Redis } from 'ioredis';

/** Fixed-window counter in Redis. Resolves `true` while `key` is within `limit` hits per window. */
export async function hit(
  redis: Redis,
  key: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSec);
  return count <= limit;
}
