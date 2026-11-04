import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { catalogTrackSchema, type CatalogTrack, type Track } from '@spotibay/shared';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { listenHistory, queueItems, tracks } from '../db/schema.js';
import { logger } from '../logger.js';
import { CatalogError, type CatalogService, type RadioSong } from './catalog.js';
import type { SettingsService } from './settings.js';

/** Plays looked at for a person, and for a room (whose taste changes with who's in it). */
const USER_PLAYS = 50;
const ROOM_PLAYS = 10;
/** Each play back counts this much less than the one after it, so recent taste leads. */
const RECENCY_DECAY = 0.95;
/** Artists whose radios the suggestions come from. */
const SEED_ARTISTS = 5;
/** Uploads with no catalog song looked up per run; the rest wait for the next one. */
const VIDEO_LOOKUPS_PER_RUN = 5;
const MAX_PER_ARTIST = 2;
const SUGGESTIONS = 20;
const CACHE_TTL_SEC = 10 * 60;
/** Deezer was busy partway: try again soon instead of keeping a short list for ten minutes. */
const PARTIAL_CACHE_TTL_SEC = 60;
/** How much popularity (log10 of Deezer's rank) and place on a radio weigh against the seed. */
const POPULARITY_WEIGHT = 0.1;
const POSITION_WEIGHT = 0.01;

/** `history`: picked from what was played. `chart`: nothing played yet, so the top chart. */
export type RecommendationBasis = 'history' | 'chart';

export interface Recommendations {
  basedOn: RecommendationBasis;
  suggestions: CatalogTrack[];
}

const cachedSchema = z.object({
  basedOn: z.enum(['history', 'chart']),
  suggestions: z.array(catalogTrackSchema),
});

/** A played track, newest first. */
interface Play {
  catalogId: string | null;
  track: Track;
}

export interface RecommendationServiceDeps {
  db: Db;
  redis: Redis;
  catalog: Pick<CatalogService, 'artistOf' | 'artistRadio' | 'findForVideo' | 'topCharts'>;
  settings: Pick<SettingsService, 'get'>;
}

/**
 * Songs to suggest from what someone (or a room) played: the artists heard most and most
 * recently become seeds, and each seed's Deezer radio (their songs and similar artists') gives the
 * candidates. Costs no YouTube quota; Deezer answers are cached, so a run is usually a few reads.
 */
export function createRecommendationService({
  db,
  redis,
  catalog,
  settings,
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

  /** Deezer being busy ends the run early with what was found; other failures are real. */
  const busy = (err: unknown) => err instanceof CatalogError && err.code === 'unavailable';

  /**
   * Ranked suggestions from `plays` (newest first); `complete` is false when Deezer was busy
   * partway through.
   */
  async function fromPlays(
    plays: Play[],
  ): Promise<{ suggestions: CatalogTrack[]; complete: boolean }> {
    let complete = true;
    const played = new Set<string>();
    const artistWeights = new Map<string, number>();
    let lookups = 0;

    for (const [i, play] of plays.entries()) {
      let catalogId = play.catalogId;
      try {
        if (!catalogId && lookups < VIDEO_LOOKUPS_PER_RUN && complete) {
          lookups++;
          catalogId = (await catalog.findForVideo(play.track))?.id ?? null;
        }
        if (!catalogId) continue;
        played.add(catalogId);
        const artistId = await catalog.artistOf(catalogId);
        if (!artistId) continue;
        artistWeights.set(artistId, (artistWeights.get(artistId) ?? 0) + RECENCY_DECAY ** i);
      } catch (err) {
        if (!(err instanceof CatalogError)) throw err;
        // A song Deezer no longer has just doesn't count; a busy Deezer stops new lookups.
        if (err.code === 'unavailable') complete = false;
      }
    }

    const seeds = [...artistWeights].sort((a, b) => b[1] - a[1]).slice(0, SEED_ARTISTS);
    const topWeight = seeds[0]?.[1] ?? 1;
    const candidates = new Map<string, { radio: RadioSong; score: number }>();
    for (const [artistId, weight] of seeds) {
      let radio: RadioSong[];
      try {
        radio = await catalog.artistRadio(artistId);
      } catch (err) {
        if (!busy(err)) throw err;
        complete = false;
        break;
      }
      for (const [position, entry] of radio.entries()) {
        if (played.has(entry.song.id)) continue;
        const score =
          weight / topWeight +
          POPULARITY_WEIGHT * Math.log10(entry.rank + 10) -
          POSITION_WEIGHT * position;
        const seen = candidates.get(entry.song.id);
        // On several seeds' radios: more likely to fit, so the scores add up.
        candidates.set(entry.song.id, { radio: entry, score: (seen?.score ?? 0) + score });
      }
    }

    const perArtist = new Map<string, number>();
    const suggestions: CatalogTrack[] = [];
    for (const { radio } of [...candidates.values()].sort((a, b) => b.score - a.score)) {
      const artist = radio.artistId ?? radio.song.artist;
      const count = perArtist.get(artist) ?? 0;
      if (count >= MAX_PER_ARTIST) continue;
      perArtist.set(artist, count + 1);
      suggestions.push(radio.song);
      if (suggestions.length === SUGGESTIONS) break;
    }
    return { suggestions, complete };
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

    /** Suggestions for someone from their listening history; the top chart before they have one. */
    forUser(userId: string): Promise<Recommendations> {
      return cached(`recs:user:${userId}`, async () => {
        const { suggestions, complete } = await fromPlays(await userPlays(userId));
        if (suggestions.length > 0) {
          return {
            basedOn: 'history',
            suggestions,
            ttl: complete ? CACHE_TTL_SEC : PARTIAL_CACHE_TTL_SEC,
          };
        }
        const chart = await catalog.topCharts();
        // Deezer was busy before anything was found: the chart stands in only briefly.
        return {
          basedOn: 'chart',
          suggestions: chart.songs,
          ttl: complete ? CACHE_TTL_SEC : PARTIAL_CACHE_TTL_SEC,
        };
      });
    },

    /** Suggestions from what the room played lately (for autoplay); empty when nothing was. */
    async forRoom(roomId: string): Promise<CatalogTrack[]> {
      try {
        return (await fromPlays(await roomPlays(roomId))).suggestions;
      } catch (err) {
        logger.warn({ err, roomId }, 'room recommendations failed');
        return [];
      }
    },
  };
}

export type RecommendationService = ReturnType<typeof createRecommendationService>;
