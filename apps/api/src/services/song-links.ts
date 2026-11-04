import type { Redis } from 'ioredis';
import { z } from 'zod';
import { hit } from '../lib/rate-limit.js';
import { logger } from '../logger.js';
import { parseVideoId } from './youtube.js';

/** Links rarely change; songs a source doesn't know are asked about again sooner. */
const FOUND_TTL_SEC = 7 * 24 * 60 * 60;
const MISSING_TTL_SEC = 24 * 60 * 60;
const cachedSchema = z.array(z.string());

/**
 * Somewhere that knows which YouTube videos are a catalog (Deezer) song, so finding one costs no
 * YouTube search. Never throws: trouble just means "no links".
 */
export interface SongLinkSource {
  /** Video ids for the song, preferred first; empty when the source doesn't know it or is busy. */
  videoIds(catalogId: string): Promise<string[]>;
}

/** YouTube Music links usually point at the "Topic" audio upload, which we prefer. */
function orderedVideoIds(urls: string[]): string[] {
  const music = urls.filter((u) => /^https?:\/\/music\.youtube\.com\//.test(u));
  const rest = urls.filter((u) => !music.includes(u));
  return [...new Set([...music, ...rest].flatMap((u) => parseVideoId(u) ?? []))];
}

/**
 * Wraps a lookup with a Redis cache (`{prefix}:{catalogId}`). A lookup answering `null` (busy or
 * failing) isn't remembered, so the next try asks again.
 */
function cached(
  redis: Redis,
  prefix: string,
  lookup: (catalogId: string) => Promise<string[] | null>,
): SongLinkSource {
  return {
    async videoIds(catalogId) {
      const key = `${prefix}:${catalogId}`;
      const hitValue = await redis.get(key);
      if (hitValue) {
        try {
          return cachedSchema.parse(JSON.parse(hitValue));
        } catch {
          // An unreadable entry is treated as a miss and overwritten below.
        }
      }
      const ids = await lookup(catalogId);
      if (ids === null) return [];
      await redis.set(
        key,
        JSON.stringify(ids),
        'EX',
        ids.length > 0 ? FOUND_TTL_SEC : MISSING_TTL_SEC,
      );
      return ids;
    },
  };
}

/** `fetch` that logs and answers `null` instead of throwing when the service can't be reached. */
async function tryFetch(fetchImpl: typeof fetch, url: URL, init: RequestInit, name: string) {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    logger.warn({ err }, `${name} unreachable`);
    return null;
  }
}

const ODESLI_API = 'https://api.song.link/v1-alpha.1/links';
/** Odesli needs a key since July 2026 (Linktree retired keyless access). Stay under its limit. */
const ODESLI_WINDOW_SEC = 60;
const ODESLI_CALLS_PER_WINDOW = 50;

const odesliResponseSchema = z.object({
  linksByPlatform: z.record(z.string(), z.object({ url: z.string() })).default({}),
});

export interface OdesliLinksDeps {
  redis: Redis;
  apiKey: string;
  /** Country whose catalogs Odesli should look in. */
  country?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Song links from Odesli (song.link), which matches by Deezer id. */
export function createOdesliLinks({
  redis,
  apiKey,
  country = 'PH',
  fetch: fetchImpl = fetch,
  now = () => new Date(),
}: OdesliLinksDeps): SongLinkSource {
  return cached(redis, 'songlinks:odesli', async (catalogId) => {
    const window = Math.floor(now().getTime() / (ODESLI_WINDOW_SEC * 1000));
    const key = `songlinks:odesli:calls:${window}`;
    if (!(await hit(redis, key, ODESLI_CALLS_PER_WINDOW, ODESLI_WINDOW_SEC))) return null;
    const url = new URL(ODESLI_API);
    url.searchParams.set('url', `https://www.deezer.com/track/${catalogId}`);
    url.searchParams.set('userCountry', country);
    url.searchParams.set('key', apiKey);
    const res = await tryFetch(fetchImpl, url, {}, 'odesli');
    if (!res) return null;
    if (res.status === 404) return [];
    if (!res.ok) {
      logger.warn({ status: res.status }, 'odesli refused');
      return null;
    }
    const parsed = odesliResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return null;
    const links = parsed.data.linksByPlatform;
    return orderedVideoIds([links.youtubeMusic?.url, links.youtube?.url].flatMap((u) => u ?? []));
  });
}

const MUSICBRAINZ_API = 'https://musicbrainz.org/ws/2';
/** MusicBrainz allows one request a second per address. */
const MUSICBRAINZ_WINDOW_SEC = 1;
const MUSICBRAINZ_CALLS_PER_WINDOW = 1;

const musicBrainzResponseSchema = z.object({
  recordings: z
    .array(
      z.object({
        relations: z
          .array(z.object({ url: z.object({ resource: z.string() }).optional() }))
          .default([]),
      }),
    )
    .default([]),
});

export interface MusicBrainzLinksDeps {
  redis: Redis;
  /** The song's ISRC (recording code), or `null` when unknown. */
  isrc: (catalogId: string) => Promise<string | null>;
  /** MusicBrainz refuses anonymous clients; name the app and how to reach it. */
  userAgent: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Song links from MusicBrainz, found through the song's ISRC. Free and open, but only some songs
 * have their YouTube upload recorded there.
 */
export function createMusicBrainzLinks({
  redis,
  isrc,
  userAgent,
  fetch: fetchImpl = fetch,
  now = () => new Date(),
}: MusicBrainzLinksDeps): SongLinkSource {
  return cached(redis, 'songlinks:musicbrainz', async (catalogId) => {
    const code = await isrc(catalogId).catch((err: unknown) => {
      logger.warn({ err }, 'isrc lookup failed');
      return undefined;
    });
    if (code === undefined) return null;
    if (code === null) return [];
    const window = Math.floor(now().getTime() / (MUSICBRAINZ_WINDOW_SEC * 1000));
    const key = `songlinks:musicbrainz:calls:${window}`;
    if (!(await hit(redis, key, MUSICBRAINZ_CALLS_PER_WINDOW, MUSICBRAINZ_WINDOW_SEC))) return null;
    const url = new URL(`${MUSICBRAINZ_API}/isrc/${encodeURIComponent(code)}`);
    url.searchParams.set('inc', 'url-rels');
    url.searchParams.set('fmt', 'json');
    const res = await tryFetch(
      fetchImpl,
      url,
      { headers: { 'User-Agent': userAgent } },
      'musicbrainz',
    );
    if (!res) return null;
    if (res.status === 404) return [];
    if (!res.ok) {
      logger.warn({ status: res.status }, 'musicbrainz refused');
      return null;
    }
    const parsed = musicBrainzResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return null;
    const urls = parsed.data.recordings.flatMap((r) =>
      r.relations.flatMap((rel) => rel.url?.resource ?? []),
    );
    return orderedVideoIds(urls);
  });
}
