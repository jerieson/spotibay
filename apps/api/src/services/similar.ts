import type { Redis } from 'ioredis';
import { z } from 'zod';
import { hit } from '../lib/rate-limit.js';
import { logger } from '../logger.js';

/** A song that listeners of another song also play, with how strongly (0 to 1). */
export interface SimilarSong {
  title: string;
  artist: string;
  match: number;
}

/**
 * Somewhere that knows which songs go with a song: "people who played X also played Y". Never
 * throws: trouble just means "none".
 */
export interface SimilarSongs {
  forSong(title: string, artist: string): Promise<SimilarSong[]>;
}

/** Used when no source is set up. */
export const noSimilarSongs: SimilarSongs = { forSong: () => Promise.resolve([]) };

const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';
const SIMILAR_LIMIT = 30;
/** Listening habits change slowly; songs Last.fm doesn't know are asked about again sooner. */
const FOUND_TTL_SEC = 7 * 24 * 60 * 60;
const MISSING_TTL_SEC = 24 * 60 * 60;
/** Last.fm asks for no more than about 5 requests a second from one address. */
const WINDOW_SEC = 1;
const CALLS_PER_WINDOW = 4;
/** Last.fm's "Track not found". */
const TRACK_NOT_FOUND = 6;

const similarSongSchema = z.object({ title: z.string(), artist: z.string(), match: z.number() });
const cachedSchema = z.array(similarSongSchema);

const responseSchema = z.object({
  similartracks: z.object({
    track: z
      .array(
        z.object({
          name: z.string(),
          match: z.coerce.number(),
          artist: z.object({ name: z.string() }),
        }),
      )
      .default([]),
  }),
});
const errorSchema = z.object({ error: z.number() });

const key = (title: string, artist: string) =>
  `similar:lastfm:${artist.trim().toLowerCase()}|${title.trim().toLowerCase()}`;

export interface LastfmSimilarDeps {
  redis: Redis;
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Similar songs from Last.fm (`track.getSimilar`), built from what its listeners play one after
 * another: the closest public stand-in for YouTube's "up next". Cached in Redis.
 */
export function createLastfmSimilar({
  redis,
  apiKey,
  fetch: fetchImpl = fetch,
  now = () => new Date(),
}: LastfmSimilarDeps): SimilarSongs {
  async function lookup(title: string, artist: string): Promise<SimilarSong[] | null> {
    const window = Math.floor(now().getTime() / (WINDOW_SEC * 1000));
    if (!(await hit(redis, `similar:lastfm:calls:${window}`, CALLS_PER_WINDOW, WINDOW_SEC))) {
      return null;
    }
    const url = new URL(LASTFM_API);
    url.searchParams.set('method', 'track.getsimilar');
    url.searchParams.set('track', title);
    url.searchParams.set('artist', artist);
    url.searchParams.set('autocorrect', '1');
    url.searchParams.set('limit', String(SIMILAR_LIMIT));
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('format', 'json');
    let body: unknown;
    try {
      const res = await fetchImpl(url);
      body = await res.json().catch(() => null);
    } catch (err) {
      logger.warn({ err }, 'last.fm unreachable');
      return null;
    }
    const error = errorSchema.safeParse(body);
    if (error.success) {
      if (error.data.error === TRACK_NOT_FOUND) return [];
      logger.warn({ code: error.data.error }, 'last.fm refused');
      return null;
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) return null;
    return parsed.data.similartracks.track.map((t) => ({
      title: t.name,
      artist: t.artist.name,
      match: Math.max(0, Math.min(1, t.match)),
    }));
  }

  return {
    async forSong(title, artist) {
      const k = key(title, artist);
      const cached = await redis.get(k);
      if (cached) {
        try {
          return cachedSchema.parse(JSON.parse(cached));
        } catch {
          // Unreadable: ask again below.
        }
      }
      const songs = await lookup(title, artist);
      // Busy or failing: not remembered, so the next run asks again.
      if (songs === null) return [];
      await redis.set(
        k,
        JSON.stringify(songs),
        'EX',
        songs.length > 0 ? FOUND_TTL_SEC : MISSING_TTL_SEC,
      );
      return songs;
    },
  };
}
