import type { Redis } from 'ioredis';
import { catalogTrackSchema, type CatalogTrack, type Track } from '@spotibay/shared';
import { z } from 'zod';
import { hit } from '../lib/rate-limit.js';
import type { SettingsService } from './settings.js';

const DEEZER_API = 'https://api.deezer.com';
const SUGGEST_LIMIT = 8;
/**
 * Deezer allows about 50 requests per 5 seconds per address, and every visitor shares the
 * server's address, so stay under it with headroom.
 */
const DEEZER_WINDOW_SEC = 5;
const DEEZER_CALLS_PER_WINDOW = 40;

export type CatalogErrorCode = 'unavailable' | 'not_found';

export class CatalogError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

const deezerTrackSchema = z.object({
  id: z.number().int().nonnegative(),
  readable: z.boolean().optional(),
  title: z.string(),
  duration: z.number().int().nonnegative(),
  artist: z.object({ name: z.string() }),
  album: z.object({
    title: z.string(),
    cover_medium: z.string().nullish(),
  }),
});
type DeezerTrack = z.infer<typeof deezerTrackSchema>;

/** Deezer answers errors (quota, unknown id) with status 200 and an `error` object. */
const deezerErrorSchema = z.object({
  error: z.object({ code: z.number().optional(), message: z.string().optional() }),
});
/** "Data not found". */
const DEEZER_NOT_FOUND = 800;

const deezerSearchSchema = z.object({ data: z.array(z.unknown()).default([]) });

const cachedSuggestionsSchema = z.array(catalogTrackSchema);

const toCatalogTrack = (t: DeezerTrack): CatalogTrack => ({
  id: String(t.id),
  title: t.title,
  artist: t.artist.name,
  album: t.album.title,
  artworkUrl: t.album.cover_medium || null,
  durationSec: t.duration,
});

export interface CatalogServiceDeps {
  redis: Redis;
  settings: Pick<SettingsService, 'get'>;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Song search and details from Deezer's public API, cached in Redis. Needs no key. */
export function createCatalogService({
  redis,
  settings,
  fetch: fetchImpl = fetch,
  now = () => new Date(),
}: CatalogServiceDeps) {
  const trackKey = (id: string) => `catalog:track:${id}`;

  async function call(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const window = Math.floor(now().getTime() / (DEEZER_WINDOW_SEC * 1000));
    if (
      !(await hit(redis, `catalog:calls:${window}`, DEEZER_CALLS_PER_WINDOW, DEEZER_WINDOW_SEC))
    ) {
      throw new CatalogError('unavailable', 'Song suggestions are busy, try again in a moment');
    }
    const url = new URL(path, DEEZER_API);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetchImpl(url);
    } catch {
      throw new CatalogError('unavailable', 'Song suggestions are unavailable right now');
    }
    if (!res.ok) throw new CatalogError('unavailable', `Deezer returned ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    const err = deezerErrorSchema.safeParse(body);
    if (err.success) {
      if (err.data.error.code === DEEZER_NOT_FOUND) {
        throw new CatalogError('not_found', 'That song was not found');
      }
      throw new CatalogError('unavailable', err.data.error.message ?? 'Deezer returned an error');
    }
    return body;
  }

  async function remember(songs: CatalogTrack[]) {
    if (songs.length === 0) return;
    const ttl = settings.get('catalog.cacheTtlSec');
    const pipeline = redis.pipeline();
    for (const song of songs) pipeline.set(trackKey(song.id), JSON.stringify(song), 'EX', ttl);
    await pipeline.exec();
  }

  /** Playable songs matching `query` (already normalized), best first. */
  async function search(query: string): Promise<CatalogTrack[]> {
    const cacheKey = `catalog:search:${query}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return cachedSuggestionsSchema.parse(JSON.parse(cached));
      } catch {
        // An unreadable entry is treated as a miss and overwritten below.
      }
    }
    const parsed = deezerSearchSchema.safeParse(
      await call('/search/track', { q: query, limit: String(SUGGEST_LIMIT) }),
    );
    if (!parsed.success) throw new CatalogError('unavailable', 'Unexpected Deezer response');
    // One malformed entry shouldn't hide the rest.
    const songs = parsed.data.data.flatMap((item) => {
      const track = deezerTrackSchema.safeParse(item);
      return track.success && track.data.readable !== false && track.data.duration > 0
        ? [toCatalogTrack(track.data)]
        : [];
    });
    await redis.set(cacheKey, JSON.stringify(songs), 'EX', settings.get('catalog.cacheTtlSec'));
    await remember(songs);
    return songs;
  }

  /** One song by Deezer id; usually from the cache that suggestions filled. */
  async function getTrack(id: string): Promise<CatalogTrack> {
    const cached = await redis.get(trackKey(id));
    if (cached) {
      try {
        return catalogTrackSchema.parse(JSON.parse(cached));
      } catch {
        // Unreadable: ask Deezer again.
      }
    }
    const parsed = deezerTrackSchema.safeParse(await call(`/track/${id}`));
    if (!parsed.success) throw new CatalogError('unavailable', 'Unexpected Deezer response');
    if (parsed.data.readable === false)
      throw new CatalogError('not_found', 'That song is unavailable');
    const song = toCatalogTrack(parsed.data);
    await remember([song]);
    return song;
  }

  return { search, getTrack };
}

export type CatalogService = ReturnType<typeof createCatalogService>;

/** Lowercase, accents and punctuation removed, single spaces. */
function words(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const compact = (text: string) => words(text).replace(/ /g, '');

/** The title without "(feat. …)", "[Remastered]" or "- Radio Edit" style suffixes. */
function coreTitle(title: string): string {
  return words(title.replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+.*$/, '')) || words(title);
}

/** Uploads that are a different recording than the catalog song unless its title says so. */
const VARIANTS = [
  'live',
  'cover',
  'karaoke',
  'instrumental',
  'remix',
  'sped up',
  'slowed',
  'nightcore',
  '8d',
  'reverb',
  'acoustic',
  'reaction',
  'tutorial',
  'hour',
  'hours',
];

const hasWord = (haystack: string, word: string) => ` ${haystack} `.includes(` ${word} `);

/**
 * The upload of `song` among YouTube `candidates`, or `null` when none is a confident match.
 * A match has the song's title, names the artist (in the title or channel), lasts about as long,
 * and isn't a live, cover or remix version the catalog song isn't. "Topic" channels (official
 * audio) win, then the artist's own channel, then the closest duration.
 */
export function pickMatch(
  song: Pick<CatalogTrack, 'title' | 'artist' | 'durationSec'>,
  candidates: Track[],
): Track | null {
  const title = coreTitle(song.title);
  const songWords = words(song.title);
  const artist = compact(song.artist);
  const tolerance = Math.max(10, song.durationSec * 0.08);
  let best: { track: Track; score: number } | null = null;
  for (const track of candidates) {
    const text = words(`${track.title} ${track.channelTitle}`);
    if (!hasWord(text, title)) continue;
    if (artist && !compact(`${track.title} ${track.channelTitle}`).includes(artist)) continue;
    const drift = Math.abs(track.durationSec - song.durationSec);
    if (drift > tolerance) continue;
    if (VARIANTS.some((v) => hasWord(text, v) && !hasWord(songWords, v))) continue;
    let score = -drift / tolerance;
    if (/ - topic$/i.test(track.channelTitle)) score += 3;
    else if (compact(track.channelTitle).includes(artist)) score += 2;
    if (hasWord(words(track.title), 'official')) score += 0.5;
    // Strictly greater keeps YouTube's ranking on ties.
    if (!best || score > best.score) best = { track, score };
  }
  return best?.track ?? null;
}
