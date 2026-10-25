import type { Redis } from 'ioredis';
import {
  MIN_SUGGEST_QUERY_LENGTH,
  trackSchema,
  type CatalogTrack,
  type ResolveResponse,
  type SearchErrorCode,
  type SearchResponse,
  type Track,
} from '@spotibay/shared';
import { z } from 'zod';
import { CatalogError, pickMatch, type CatalogService } from './catalog.js';
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

/** Which video plays each catalog song, once someone has added it. */
export interface CatalogMatchStore {
  find(catalogId: string): Promise<string | null>;
  /** Records the match and gives the video the song's title, artist and artwork. */
  save(song: CatalogTrack, videoId: string): Promise<void>;
}

export interface SearchServiceDeps {
  redis: Redis;
  settings: Pick<SettingsService, 'get'>;
  quota: Pick<QuotaStore, 'get'>;
  youtube: {
    search(query: string): Promise<StoredTrack[]>;
    getVideos(videoIds: string[]): Promise<Map<string, StoredTrack>>;
  };
  catalog: Pick<CatalogService, 'search' | 'getTrack'>;
  matches: CatalogMatchStore;
  now?: () => Date;
}

const toTrack = ({ videoId, title, channelTitle, thumbnailUrl, durationSec }: Track): Track => ({
  videoId,
  title,
  channelTitle,
  thumbnailUrl,
  durationSec,
});

export function createSearchService({
  redis,
  settings,
  quota,
  youtube,
  catalog,
  matches,
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
    const results = tracks.map(toTrack);
    await redis.set(cacheKey, JSON.stringify(results), 'EX', settings.get('search.cacheTtlSec'));
    return { results, remainingSearchesToday: Math.max(0, limit - used) };
  }

  function catalogError(err: unknown): never {
    if (err instanceof CatalogError) {
      if (err.code === 'not_found') throw new SearchError('catalog_not_found', err.message);
      throw new SearchError('catalog_unavailable', err.message);
    }
    throw err;
  }

  /** Catalog songs for a partly typed query. Costs no YouTube quota and no searches. */
  async function suggest(rawQuery: string): Promise<CatalogTrack[]> {
    if (!settings.get('features.catalogSearch')) {
      throw new SearchError('catalog_disabled', 'Song suggestions are turned off');
    }
    const query = normalizeQuery(rawQuery);
    if (query.length < MIN_SUGGEST_QUERY_LENGTH) return [];
    return catalog.search(query).catch(catalogError);
  }

  /**
   * The video for a catalog song. A song someone already added is free; otherwise this runs one
   * YouTube search for it (with the usual limits) and remembers the match for everyone.
   */
  async function resolve(userId: string, catalogId: string): Promise<ResolveResponse> {
    if (!settings.get('features.catalogSearch')) {
      throw new SearchError('catalog_disabled', 'Song suggestions are turned off');
    }
    const known = await matches.find(catalogId);
    if (known) {
      const track = (await youtube.getVideos([known])).get(known);
      if (track?.embeddable) {
        return {
          status: 'matched',
          track: toTrack(track),
          remainingSearchesToday: await remainingFor(userId),
        };
      }
      // The video went away or stopped allowing embeds: look for another one below.
    }
    const song = await catalog.getTrack(catalogId).catch(catalogError);
    const { results, remainingSearchesToday } = await search(
      userId,
      `${song.artist} ${song.title}`,
    );
    const match = pickMatch(
      song,
      results.filter((r) => r.videoId !== known),
    );
    if (!match) return { status: 'no_match', results, remainingSearchesToday };
    await matches.save(song, match.videoId);
    const track = (await youtube.getVideos([match.videoId])).get(match.videoId) ?? match;
    return { status: 'matched', track: toTrack(track), remainingSearchesToday };
  }

  return { search, suggest, resolve };
}

export type SearchService = ReturnType<typeof createSearchService>;
