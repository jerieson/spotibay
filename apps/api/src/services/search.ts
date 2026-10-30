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
import { hit } from '../lib/rate-limit.js';
import { CatalogError, pickMatch, type CatalogService } from './catalog.js';
import type { SettingsService } from './settings.js';
import {
  quotaDate,
  quotaResetAt,
  YouTubeError,
  type QuotaStore,
  type StoredTrack,
} from './youtube.js';

export class SearchError extends Error {
  constructor(
    readonly code: SearchErrorCode,
    message: string,
    /** For `search_budget_exhausted`: when searching works again. */
    readonly resetAt?: Date,
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
  async function search(userId: string, rawQuery: string): Promise<SearchResponse> {
    if (!settings.get('features.search')) {
      throw new SearchError('search_disabled', 'Search is turned off');
    }
    const query = normalizeQuery(rawQuery);
    const cacheKey = `search:${query}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return { results: cachedResultsSchema.parse(JSON.parse(cached)) };
      } catch {
        // An unreadable entry is treated as a miss and overwritten below.
      }
    }

    const date = quotaDate(now());
    if ((await quota.get(date)).searchCalls >= settings.get('search.dailySearchCallBudget')) {
      throw budgetExhausted();
    }
    // No daily cap per person; a burst limit keeps one person from using up the app's budget.
    const key = `ratelimit:search:${userId}`;
    if (!(await hit(redis, key, settings.get('limits.searchesPerMinute'), 60))) {
      throw new SearchError('search_rate_limited', 'Slow down, try again in a minute');
    }

    let tracks: StoredTrack[];
    try {
      tracks = await youtube.search(query);
    } catch (err) {
      // A search that never produced an answer shouldn't count against the user.
      await redis.decr(key);
      if (err instanceof YouTubeError && err.code === 'quota_exceeded') throw budgetExhausted();
      throw err;
    }
    const results = tracks.map(toTrack);
    await redis.set(cacheKey, JSON.stringify(results), 'EX', settings.get('search.cacheTtlSec'));
    return { results };
  }

  function budgetExhausted() {
    return new SearchError(
      'search_budget_exhausted',
      "Today's YouTube searches are used up. Pick a suggested song or paste a YouTube link instead.",
      quotaResetAt(now()),
    );
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
      if (track?.embeddable) return { status: 'matched', track: toTrack(track) };
      // The video went away or stopped allowing embeds: look for another one below.
    }
    const song = await catalog.getTrack(catalogId).catch(catalogError);
    const { results } = await search(userId, `${song.artist} ${song.title}`);
    const match = pickMatch(
      song,
      results.filter((r) => r.videoId !== known),
    );
    if (!match) return { status: 'no_match', results };
    await matches.save(song, match.videoId);
    const track = (await youtube.getVideos([match.videoId])).get(match.videoId) ?? match;
    return { status: 'matched', track: toTrack(track) };
  }

  return { search, suggest, resolve };
}

export type SearchService = ReturnType<typeof createSearchService>;
