import type { Redis } from 'ioredis';
import {
  trackSchema,
  type SearchErrorCode,
  type SearchResponse,
  type Track,
} from '@spotibay/shared';
import { z } from 'zod';
import type { SettingsService } from './settings.js';
import { quotaDate, type QuotaStore, type StoredTrack } from './youtube.js';

const USER_COUNT_TTL_SEC = 2 * 24 * 60 * 60;

export class SearchError extends Error {
  constructor(
    readonly code: SearchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}

/** Trim, lowercase and collapse whitespace so equivalent queries share one cache entry. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

const cachedResultsSchema = z.array(trackSchema);

export interface SearchServiceDeps {
  redis: Redis;
  settings: Pick<SettingsService, 'get'>;
  quota: Pick<QuotaStore, 'get'>;
  youtube: { search(query: string): Promise<StoredTrack[]> };
  now?: () => Date;
}

export function createSearchService({
  redis,
  settings,
  quota,
  youtube,
  now = () => new Date(),
}: SearchServiceDeps) {
  const countKey = (userId: string) => `searchcount:${userId}:${quotaDate(now())}`;

  async function remainingFor(userId: string): Promise<number> {
    const used = Number((await redis.get(countKey(userId))) ?? 0);
    return Math.max(0, settings.get('limits.searchesPerUserPerDay') - used);
  }

  async function search(userId: string, rawQuery: string): Promise<SearchResponse> {
    if (!settings.get('features.search')) {
      throw new SearchError('search_disabled', 'Search is turned off');
    }
    const query = normalizeQuery(rawQuery);
    const cacheKey = `search:${query}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        const results = cachedResultsSchema.parse(JSON.parse(cached));
        return { results, remainingSearchesToday: await remainingFor(userId) };
      } catch {
        // An unreadable entry is treated as a miss and overwritten below.
      }
    }

    const date = quotaDate(now());
    if ((await quota.get(date)).searchCalls >= settings.get('search.dailySearchCallBudget')) {
      throw new SearchError('search_budget_exhausted', 'Search is used up for today');
    }
    const limit = settings.get('limits.searchesPerUserPerDay');
    const key = countKey(userId);
    const used = await redis.incr(key);
    await redis.expire(key, USER_COUNT_TTL_SEC);
    if (used > limit) {
      await redis.decr(key);
      throw new SearchError('search_user_limit', "You've used all your searches for today");
    }

    let tracks: StoredTrack[];
    try {
      tracks = await youtube.search(query);
    } catch (err) {
      // A search that never produced an answer shouldn't cost the user one.
      await redis.decr(key);
      throw err;
    }
    const results: Track[] = tracks.map(
      ({ videoId, title, channelTitle, thumbnailUrl, durationSec }) => ({
        videoId,
        title,
        channelTitle,
        thumbnailUrl,
        durationSec,
      }),
    );
    await redis.set(cacheKey, JSON.stringify(results), 'EX', settings.get('search.cacheTtlSec'));
    return { results, remainingSearchesToday: Math.max(0, limit - used) };
  }

  return { search };
}

export type SearchService = ReturnType<typeof createSearchService>;
