import type { Redis } from 'ioredis';
import { catalogTrackSchema, type CatalogTrack, type Track } from '@spotibay/shared';
import { z } from 'zod';
import { hit } from '../lib/rate-limit.js';
import type { SettingsService } from './settings.js';

const DEEZER_API = 'https://api.deezer.com';
const SUGGEST_LIMIT = 8;
/** Deezer is asked for more than are shown, so imitations can be dropped and the rest re-ranked. */
const SUGGEST_FETCH_LIMIT = 25;
/** How much each place down Deezer's relevance order costs, against log10 of its popularity. */
const POSITION_WEIGHT = 0.15;
/** Bonus for a song on the current chart: it's probably the one people are typing. */
const CHART_BOOST = 1;
const CHART_SIZE = 20;
const CHART_TTL_SEC = 6 * 60 * 60;
/** A chart cut short (Deezer busy) is retried sooner. */
const PARTIAL_CHART_TTL_SEC = 10 * 60;
/** Which Deezer song an Apple chart entry is; neither changes. */
const CHART_ENTRY_TTL_SEC = 30 * 24 * 60 * 60;
const APPLE_CHART = 'https://rss.marketingtools.apple.com/api/v2';
/**
 * Deezer allows about 50 requests per 5 seconds per address, and every visitor shares the
 * server's address, so stay under it with headroom.
 */
const DEEZER_WINDOW_SEC = 5;
const DEEZER_CALLS_PER_WINDOW = 40;
/** A recording's ISRC never changes. */
const ISRC_TTL_SEC = 30 * 24 * 60 * 60;

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
  /** Only in full track details, not in search results. */
  isrc: z.string().optional(),
  title: z.string(),
  duration: z.number().int().nonnegative(),
  /** Popularity; higher is more played. */
  rank: z.number().optional(),
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

const appleChartSchema = z.object({
  feed: z.object({
    results: z.array(z.object({ id: z.string(), name: z.string(), artistName: z.string() })),
  }),
});

/** Popular songs in a country; `country` is `null` when it's Deezer's worldwide chart instead. */
export const chartSchema = z.object({
  country: z.string().nullable(),
  songs: z.array(catalogTrackSchema),
});
export type Chart = z.infer<typeof chartSchema>;

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

  /** Deezer tracks in an answer that can be played; one malformed entry doesn't hide the rest. */
  function playable(body: unknown): DeezerTrack[] {
    const parsed = deezerSearchSchema.safeParse(body);
    if (!parsed.success) throw new CatalogError('unavailable', 'Unexpected Deezer response');
    return parsed.data.data.flatMap((item) => {
      const track = deezerTrackSchema.safeParse(item);
      return track.success && track.data.readable !== false && track.data.duration > 0
        ? [track.data]
        : [];
    });
  }

  /** Search answers carry ISRCs too, which saves song-link lookups a call later. */
  async function rememberIsrcs(tracks: DeezerTrack[]) {
    const pipeline = redis.pipeline();
    for (const t of tracks) {
      if (t.isrc) pipeline.set(`catalog:isrc:${t.id}`, t.isrc, 'EX', ISRC_TTL_SEC);
    }
    await pipeline.exec();
  }

  /**
   * Playable songs matching `query` (already normalized), best first. Karaoke, cover and tribute
   * entries are dropped unless the query asks for them, and Deezer's order is weighed against
   * popularity, so the real recording beats a sound-alike that happens to match better.
   */
  async function search(query: string): Promise<CatalogTrack[]> {
    const cacheKey = `catalog:suggest:${query}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return cachedSuggestionsSchema.parse(JSON.parse(cached));
      } catch {
        // An unreadable entry is treated as a miss and overwritten below.
      }
    }
    const found = playable(
      await call('/search/track', { q: query, limit: String(SUGGEST_FETCH_LIMIT) }),
    );
    const charted = new Set((await cachedChart())?.songs.map((s) => s.id));
    const songs = rankSuggestions(query, found, charted)
      .slice(0, SUGGEST_LIMIT)
      .map(toCatalogTrack);
    await redis.set(cacheKey, JSON.stringify(songs), 'EX', settings.get('catalog.cacheTtlSec'));
    await remember(songs);
    await rememberIsrcs(found);
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

  /** The song's ISRC (recording code), from Deezer's full details; `null` when it has none. */
  async function isrc(id: string): Promise<string | null> {
    const key = `catalog:isrc:${id}`;
    const cached = await redis.get(key);
    if (cached !== null) return cached || null;
    const parsed = deezerTrackSchema.safeParse(await call(`/track/${id}`));
    if (!parsed.success) throw new CatalogError('unavailable', 'Unexpected Deezer response');
    const code = parsed.data.isrc ?? '';
    await redis.set(key, code, 'EX', ISRC_TTL_SEC);
    return code || null;
  }

  const chartKey = () => `catalog:chart:${settings.get('search.region') || 'global'}`;

  async function cachedChart(): Promise<Chart | null> {
    const cached = await redis.get(chartKey());
    if (!cached) return null;
    try {
      return chartSchema.parse(JSON.parse(cached));
    } catch {
      return null;
    }
  }

  /** The Deezer song an Apple chart entry is, from a cached answer or one Deezer search. */
  async function chartEntry(entry: { id: string; name: string; artistName: string }) {
    const key = `catalog:apple:${entry.id}`;
    const cachedId = await redis.get(key);
    if (cachedId !== null) {
      return cachedId ? getTrack(cachedId).catch(() => null) : null;
    }
    const artist = firstArtist(entry.artistName);
    const found = playable(
      await call('/search/track', { q: `${words(artist)} ${coreTitle(entry.name)}`, limit: '5' }),
    );
    const match = found.find(
      (t) =>
        coreTitle(t.title) === coreTitle(entry.name) &&
        (compact(t.artist.name).includes(compact(artist)) ||
          compact(artist).includes(compact(t.artist.name))),
    );
    await redis.set(key, match ? String(match.id) : '', 'EX', CHART_ENTRY_TTL_SEC);
    if (!match) return null;
    const song = toCatalogTrack(match);
    await remember([song]);
    return song;
  }

  /**
   * Apple Music's most played songs in the country, found on Deezer one by one (each lookup is
   * remembered). `null` when the chart can't be had, such as for a country Apple has no chart for.
   */
  async function appleChart(
    country: string,
  ): Promise<{ songs: CatalogTrack[]; complete: boolean } | null> {
    const url = `${APPLE_CHART}/${country.toLowerCase()}/music/most-played/${CHART_SIZE}/songs.json`;
    let body: unknown;
    try {
      const res = await fetchImpl(url);
      if (!res.ok) return null;
      body = await res.json();
    } catch {
      return null;
    }
    const parsed = appleChartSchema.safeParse(body);
    if (!parsed.success || parsed.data.feed.results.length === 0) return null;
    const songs: CatalogTrack[] = [];
    for (const entry of parsed.data.feed.results) {
      try {
        const song = await chartEntry(entry);
        if (song && !songs.some((s) => s.id === song.id)) songs.push(song);
      } catch (err) {
        // Deezer is busy: show what was found and finish the chart later.
        if (err instanceof CatalogError && err.code === 'unavailable') {
          return { songs, complete: false };
        }
        throw err;
      }
    }
    return { songs, complete: true };
  }

  let building: Promise<Chart> | null = null;

  /** The region's top songs (setting `search.region`), or Deezer's worldwide chart without one. */
  async function topCharts(): Promise<Chart> {
    const cached = await cachedChart();
    if (cached) return cached;
    // Everyone opening the sheet at once shares one build.
    building ??= (async () => {
      const country = settings.get('search.region');
      const apple = country ? await appleChart(country) : null;
      let chart: Chart;
      let complete = true;
      if (apple && apple.songs.length > 0) {
        chart = { country, songs: apple.songs };
        complete = apple.complete;
      } else {
        const songs = playable(await call('/chart/0/tracks', { limit: String(CHART_SIZE) })).map(
          toCatalogTrack,
        );
        await remember(songs);
        chart = { country: null, songs };
      }
      await redis.set(
        chartKey(),
        JSON.stringify(chart),
        'EX',
        complete ? CHART_TTL_SEC : PARTIAL_CHART_TTL_SEC,
      );
      return chart;
    })().finally(() => {
      building = null;
    });
    return building;
  }

  return { search, getTrack, isrc, topCharts };
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

/** "Cup of Joe & Janine Teñoso" -> "Cup of Joe": catalogs credit guests differently. */
function firstArtist(artist: string): string {
  return artist.split(/,|&| x | feat\.? | ft\.? | with /i)[0]?.trim() || artist;
}

/** Catalog entries that imitate a song rather than being it, unless the query asks for them. */
const IMITATIONS = [
  'karaoke',
  'cover',
  'covers',
  'tribute',
  'made famous',
  'in the style of',
  'originally performed',
  'backing track',
  'instrumental',
  'lullaby',
  'music box',
  'nightcore',
  'sped up',
  'slowed',
  '8d',
];

/**
 * Whether the title, artist and album hold every word of the query; the last one may be half
 * typed. Deezer also answers loose matches (lyrics, other spellings), which are only worth showing
 * when nothing names the query.
 */
function namesQuery(asked: string, t: DeezerTrack): boolean {
  const have = words(`${t.title} ${t.artist.name} ${t.album.title}`).split(' ');
  const want = asked.split(' ').filter(Boolean);
  return want.every((w, i) =>
    i === want.length - 1 ? have.some((h) => h.startsWith(w)) : have.includes(w),
  );
}

/**
 * Deezer's matches for `query`, imitations dropped, best first: only songs naming every word of
 * the query when there are any; then earlier in Deezer's relevance order is better, and so is
 * more popular (log of its rank) or on the chart.
 */
function rankSuggestions(
  query: string,
  found: DeezerTrack[],
  charted: ReadonlySet<string>,
): DeezerTrack[] {
  const asked = words(query);
  const real = found.filter((t) => {
    // The song's own name can hold such a word ("Cover Me", or a single named after it); its
    // version tags and credits can't.
    const name = coreTitle(t.title);
    const tags = t.title.match(/[([].*?[)\]]|\s+-\s+.*$/g)?.join(' ') ?? '';
    const album = ` ${words(t.album.title)} `.replace(` ${name} `, ' ');
    const text = words(`${tags} ${t.artist.name} ${album}`);
    return !IMITATIONS.some((v) => hasWord(text, v) && !hasWord(asked, v));
  });
  const named = real.filter((t) => namesQuery(asked, t));
  return (named.length > 0 ? named : real)
    .map((t, position) => ({
      t,
      score:
        Math.log10((t.rank ?? 0) + 10) -
        position * POSITION_WEIGHT +
        (charted.has(String(t.id)) ? CHART_BOOST : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map(({ t }) => t);
}

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
  'fan made',
  'fanmade',
  'reupload',
  'tribute',
];

const hasWord = (haystack: string, word: string) => ` ${haystack} `.includes(` ${word} `);

/** How far, in seconds, an upload's length may be from the song's and still be the song. */
export const durationTolerance = (durationSec: number) => Math.max(10, durationSec * 0.08);

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
  const tolerance = durationTolerance(song.durationSec);
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
    // A lyric video is the song, but the official audio or video is the better pick.
    if (/\blyrics?\b/.test(words(track.title)) && !/\blyrics?\b/.test(songWords)) score -= 1;
    // Strictly greater keeps YouTube's ranking on ties.
    if (!best || score > best.score) best = { track, score };
  }
  return best?.track ?? null;
}
