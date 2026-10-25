import type { Redis } from 'ioredis';

/** Fixed-window counter in Redis. Resolves `true` while `key` is within `limit` hits per window. */
export async function hit(
  redis: Redis,
  key: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  // One transaction, so a crash between the two can't leave a counter that never expires.
  const results = await redis.multi().incr(key).expire(key, windowSec, 'NX').exec();
  const [err, count] = results?.[0] ?? [new Error('rate limit transaction aborted'), 0];
  if (err) throw err;
  return Number(count) <= limit;
}
