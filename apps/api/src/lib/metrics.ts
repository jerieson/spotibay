import type { Redis } from 'ioredis';
import { quotaDate } from '../services/youtube.js';

/** How long daily counters are kept: enough for the admin's 14-day charts. */
const METRICS_TTL_SEC = 30 * 24 * 60 * 60;

export const metricNames = [
  /** A suggested song someone had already matched to a video. */
  'match_cache',
  /** Matched through a free link source (Odesli, MusicBrainz): no YouTube search spent. */
  'match_links',
  /** Matched by a YouTube search (100 quota units). */
  'match_search',
  /** Nothing matched; the person picked from search results. */
  'match_none',
  /** A typed YouTube search answered from the cache. */
  'search_cache',
  /** A typed YouTube search sent to YouTube. */
  'search_youtube',
  /** A YouTube search autoplay spent on a song nobody had matched (also in `search_youtube`). */
  'search_autoplay',
  /** Autoplay queued a song. */
  'autoplay_queued',
  /** Autoplay found nothing to queue: the room went quiet. */
  'autoplay_none',
] as const;
export type MetricName = (typeof metricNames)[number];

/** Daily counters in one Redis hash per day (`metrics:{date}`, Pacific Time like the quota). */
export function createMetrics(redis: Redis, now: () => Date = () => new Date()) {
  const key = (date: string) => `metrics:${date}`;

  async function incr(name: MetricName, by = 1): Promise<void> {
    const k = key(quotaDate(now()));
    await redis.multi().hincrby(k, name, by).expire(k, METRICS_TTL_SEC).exec();
  }

  async function get(date: string): Promise<Record<MetricName, number>> {
    const raw = await redis.hgetall(key(date));
    return Object.fromEntries(metricNames.map((n) => [n, Number(raw[n] ?? 0)])) as Record<
      MetricName,
      number
    >;
  }

  return { incr, get };
}

export type Metrics = ReturnType<typeof createMetrics>;
