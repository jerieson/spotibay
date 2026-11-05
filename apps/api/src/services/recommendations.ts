import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { catalogTrackSchema, type CatalogTrack, type Track } from '@spotibay/shared';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { listenHistory, queueItems, tracks } from '../db/schema.js';
import { logger } from '../logger.js';
import { CatalogError, type CatalogService } from './catalog.js';
import type { SettingsService } from './settings.js';
import { noSimilarSongs, type SimilarSongs } from './similar.js';

/** Plays looked at for a person, and for a room (whose taste changes with who's in it). */
const USER_PLAYS = 50;
const ROOM_PLAYS = 10;
/** Each play back counts this much less than the one after it, so recent taste leads. */
const RECENCY_DECAY = 0.8;
/** The last few songs seed "goes with this song" picks; each one back counts half as much. */
const SONG_SEEDS = 3;
const SONG_SEED_DECAY = 0.5;
/** Similar songs looked up on the catalog for the newest seed; older seeds get fewer. */
const SIMILAR_PER_SEED = 10;
/** Artists whose radios the suggestions also come from. */
const SEED_ARTISTS = 5;
/** Uploads with no catalog song looked up per run; the rest wait for the next one. */
const VIDEO_LOOKUPS_PER_RUN = 5;
/** Songs skipped lately in a room are left out of its picks. */
const ROOM_SKIPS = 20;
const MAX_PER_ARTIST = 2;
const SUGGESTIONS = 20;
const CACHE_TTL_SEC = 10 * 60;
/** Deezer was busy partway: try again soon instead of keeping a short list for ten minutes. */
const PARTIAL_CACHE_TTL_SEC = 60;
/**
 * How the sources weigh against each other. Songs that go with the last song lead (Last.fm's
 * listeners, then what people in Spotibay chose next); artist radios fill in around them.
 */
const SIMILAR_WEIGHT = 3;
const COPLAY_WEIGHT = 1.5;
const RADIO_WEIGHT = 1;
/** How much popularity (log10 of Deezer's rank) and place on a radio weigh. */
const POPULARITY_WEIGHT = 0.1;
const POSITION_WEIGHT = 0.01;

/** `history`: picked from what was played. `chart`: nothing played yet, so the top chart. */
export type RecommendationBasis = 'history' | 'chart';

/** The song the picks follow from: the last one played. */
export interface RecommendationSeed {
  title: string;
  artist: string;
}

export interface Recommendations {
  basedOn: RecommendationBasis;
  seed: RecommendationSeed | null;
  suggestions: CatalogTrack[];
}

const cachedSchema = z.object({
  basedOn: z.enum(['history', 'chart']),
  seed: z.object({ title: z.string(), artist: z.string() }).nullable(),
  suggestions: z.array(catalogTrackSchema),
});

/** A played track, newest first. */
interface Play {
  catalogId: string | null;
  track: Track;
}

/** A song from the plays that seeds "goes with this" picks, and how much it counts. */
interface SongSeed {
  videoId: string;
  song: RecommendationSeed | null;
  weight: number;
}

export interface RecommendationServiceDeps {
  db: Db;
  redis: Redis;
  catalog: Pick<
    CatalogService,
    'artistOf' | 'artistRadio' | 'findForVideo' | 'findByName' | 'getTrack' | 'topCharts'
  >;
  settings: Pick<SettingsService, 'get'>;
  /** Last.fm's similar songs; without it, picks come from co-plays and artist radios. */
  similar?: SimilarSongs;
}

/**
 * Songs to suggest from what someone (or a room) played, led by the last song: songs Last.fm's
 * listeners play with it, songs people in Spotibay chose right after it, then the radios
 * (their songs and similar artists') of the artists heard most and most recently. Costs no
 * YouTube quota; Deezer and Last.fm answers are cached, so a run is usually a few reads.
 */
export function createRecommendationService({
  db,
  redis,
  catalog,
  settings,
  similar = noSimilarSongs,
}: RecommendationServiceDeps) {
  const trackColumns = {
    catalogId: tracks.catalogId,
    videoId: tracks.videoId,
    title: tracks.title,
    channelTitle: tracks.channelTitle,
    thumbnailUrl: tracks.thumbnailUrl,
    durationSec: tracks.durationSec,
  };
  const toPlay = ({ catalogId, ...track }: { catalogId: string | null } & Track): Play => ({
    catalogId,
    track,
  });

  async function userPlays(userId: string): Promise<Play[]> {
    const rows = await db
      .select(trackColumns)
      .from(listenHistory)
      .innerJoin(tracks, eq(tracks.videoId, listenHistory.videoId))
      .where(eq(listenHistory.userId, userId))
      .orderBy(desc(listenHistory.id))
      .limit(USER_PLAYS);
    return rows.map(toPlay);
  }

  async function roomPlays(roomId: string): Promise<Play[]> {
    const rows = await db
      .select(trackColumns)
      .from(queueItems)
      .innerJoin(tracks, eq(tracks.videoId, queueItems.videoId))
      .where(
        and(
          eq(queueItems.roomId, roomId),
          inArray(queueItems.status, ['playing', 'played']),
          isNotNull(queueItems.startedAt),
        ),
      )
      .orderBy(desc(queueItems.startedAt))
      .limit(ROOM_PLAYS);
    return rows.map(toPlay);
  }

  /** Catalog ids of songs skipped lately in the room. */
  async function roomSkips(roomId: string): Promise<Set<string>> {
    const rows = await db
      .select({ catalogId: tracks.catalogId })
      .from(queueItems)
      .innerJoin(tracks, eq(tracks.videoId, queueItems.videoId))
      .where(and(eq(queueItems.roomId, roomId), eq(queueItems.status, 'skipped')))
      .orderBy(desc(queueItems.endedAt))
      .limit(ROOM_SKIPS);
    return new Set(rows.flatMap((r) => r.catalogId ?? []));
  }

  /**
   * Songs people in Spotibay chose right after each of `videoIds`, across all rooms, with how
   * often. Only songs a person queued count, so autoplay's own picks don't feed back into it.
   */
  async function coPlays(
    videoIds: string[],
  ): Promise<{ from: string; catalogId: string; plays: number }[]> {
    if (videoIds.length === 0) return [];
    const result = await db.execute<{ from: string; catalog_id: string; plays: number }>(sql`
      select q.video_id as "from", t.catalog_id, count(*)::int as plays
      from (
        select video_id,
          lead(video_id) over w as next_video,
          lead(source) over w as next_source
        from ${queueItems}
        where started_at is not null and status in ('playing', 'played', 'skipped')
        window w as (partition by room_id order by started_at)
      ) q
      join ${tracks} t on t.video_id = q.next_video
      where q.video_id in (${sql.join(
        videoIds.map((id) => sql`${id}`),
        sql`, `,
      )})
        and q.next_source = 'user'
        and q.next_video <> q.video_id
        and t.catalog_id is not null
      group by q.video_id, t.catalog_id
      order by plays desc
      limit 30
    `);
    return result.rows.map((r) => ({ from: r.from, catalogId: r.catalog_id, plays: r.plays }));
  }

  /** Deezer being busy ends the run early with what was found; other failures are real. */
  const busy = (err: unknown) => err instanceof CatalogError && err.code === 'unavailable';

  /**
   * Ranked suggestions from `plays` (newest first), leaving out `skipped` songs; `complete` is
   * false when Deezer was busy partway through.
   */
  async function fromPlays(
    plays: Play[],
    skipped: ReadonlySet<string> = new Set(),
  ): Promise<{ suggestions: CatalogTrack[]; seed: RecommendationSeed | null; complete: boolean }> {
    let complete = true;
    const played = new Set<string>();
    const artistWeights = new Map<string, number>();
    const seeds: SongSeed[] = [];
    let lookups = 0;

    for (const [i, play] of plays.entries()) {
      let catalogId = play.catalogId;
      // A track with a catalog song was given its clean title and artist when it was matched.
      let song: RecommendationSeed | null = catalogId
        ? { title: play.track.title, artist: play.track.channelTitle }
        : null;
      try {
        if (!catalogId && lookups < VIDEO_LOOKUPS_PER_RUN && complete) {
          lookups++;
          const found = await catalog.findForVideo(play.track);
          catalogId = found?.id ?? null;
          if (found) song = { title: found.title, artist: found.artist };
        }
      } catch (err) {
        if (!(err instanceof CatalogError)) throw err;
        if (err.code === 'unavailable') complete = false;
      }
      if (i < SONG_SEEDS) {
        seeds.push({ videoId: play.track.videoId, song, weight: SONG_SEED_DECAY ** i });
      }
      if (!catalogId) continue;
      played.add(catalogId);
      try {
        const artistId = await catalog.artistOf(catalogId);
        if (!artistId) continue;
        artistWeights.set(artistId, (artistWeights.get(artistId) ?? 0) + RECENCY_DECAY ** i);
      } catch (err) {
        if (!(err instanceof CatalogError)) throw err;
        // A song Deezer no longer has just doesn't count; a busy Deezer stops new lookups.
        if (err.code === 'unavailable') complete = false;
      }
    }

    const candidates = new Map<string, { song: CatalogTrack; score: number }>();
    /** Scores add up: a song several sources (or seeds) point at is more likely to fit. */
    function add(song: CatalogTrack, score: number) {
      if (played.has(song.id) || skipped.has(song.id)) return;
      const seen = candidates.get(song.id);
      candidates.set(song.id, { song, score: (seen?.score ?? 0) + score });
    }

    // Songs Last.fm's listeners play with the last few songs.
    similar: for (const seed of seeds) {
      if (!seed.song) continue;
      const wanted = Math.ceil(SIMILAR_PER_SEED * seed.weight);
      for (const s of (await similar.forSong(seed.song.title, seed.song.artist)).slice(0, wanted)) {
        try {
          const song = await catalog.findByName(s.title, s.artist);
          if (song) add(song, SIMILAR_WEIGHT * seed.weight * s.match);
        } catch (err) {
          if (!busy(err)) throw err;
          complete = false;
          break similar;
        }
      }
    }

    // Songs people in Spotibay chose right after them.
    const seedWeight = new Map(seeds.map((s) => [s.videoId, s.weight]));
    for (const { from, catalogId, plays: count } of await coPlays([...seedWeight.keys()])) {
      if (played.has(catalogId) || skipped.has(catalogId)) continue;
      try {
        const song = await catalog.getTrack(catalogId);
        add(song, COPLAY_WEIGHT * (seedWeight.get(from) ?? 0) * Math.log2(1 + count));
      } catch (err) {
        if (!(err instanceof CatalogError)) throw err;
        if (err.code === 'unavailable') {
          complete = false;
          break;
        }
      }
    }

    // The radios of the artists heard most and most recently.
    const artists = [...artistWeights].sort((a, b) => b[1] - a[1]).slice(0, SEED_ARTISTS);
    const topWeight = artists[0]?.[1] ?? 1;
    for (const [artistId, weight] of artists) {
      let radio;
      try {
        radio = await catalog.artistRadio(artistId);
      } catch (err) {
        if (!busy(err)) throw err;
        complete = false;
        break;
      }
      for (const [position, entry] of radio.entries()) {
        add(
          entry.song,
          RADIO_WEIGHT * (weight / topWeight) +
            POPULARITY_WEIGHT * Math.log10(entry.rank + 10) -
            POSITION_WEIGHT * position,
        );
      }
    }

    const perArtist = new Map<string, number>();
    const suggestions: CatalogTrack[] = [];
    for (const { song } of [...candidates.values()].sort((a, b) => b.score - a.score)) {
      const artist = song.artist.toLowerCase();
      const count = perArtist.get(artist) ?? 0;
      if (count >= MAX_PER_ARTIST) continue;
      perArtist.set(artist, count + 1);
      suggestions.push(song);
      if (suggestions.length === SUGGESTIONS) break;
    }
    return { suggestions, seed: seeds[0]?.song ?? null, complete };
  }

  async function cached(key: string, build: () => Promise<Recommendations & { ttl: number }>) {
    const hit = await redis.get(key);
    if (hit) {
      try {
        return cachedSchema.parse(JSON.parse(hit));
      } catch {
        // Unreadable: build it again below.
      }
    }
    const { ttl, ...recommendations } = await build();
    await redis.set(key, JSON.stringify(recommendations), 'EX', ttl);
    return recommendations;
  }

  return {
    /** Suggestions come from the catalog, so they're off when catalog search is. */
    enabled: () => settings.get('features.catalogSearch'),

    /**
     * Suggestions for someone, led by the last song they played; the top chart before they have
     * played anything. A new song played gives a new list.
     */
    async forUser(userId: string): Promise<Recommendations> {
      const plays = await userPlays(userId);
      const last = plays[0]?.track.videoId ?? 'none';
      return cached(`recs:user:${userId}:${last}`, async () => {
        const { suggestions, seed, complete } = await fromPlays(plays);
        const ttl = complete ? CACHE_TTL_SEC : PARTIAL_CACHE_TTL_SEC;
        if (suggestions.length > 0) return { basedOn: 'history', seed, suggestions, ttl };
        // Deezer was busy before anything was found: the chart stands in only briefly.
        const chart = await catalog.topCharts();
        return { basedOn: 'chart', seed: null, suggestions: chart.songs, ttl };
      });
    },

    /**
     * Suggestions from what the room played lately, led by the song playing now (for autoplay);
     * songs skipped there are left out. Empty when nothing was played.
     */
    async forRoom(roomId: string): Promise<CatalogTrack[]> {
      try {
        const [plays, skipped] = await Promise.all([roomPlays(roomId), roomSkips(roomId)]);
        return (await fromPlays(plays, skipped)).suggestions;
      } catch (err) {
        logger.warn({ err, roomId }, 'room recommendations failed');
        return [];
      }
    },
  };
}

export type RecommendationService = ReturnType<typeof createRecommendationService>;
