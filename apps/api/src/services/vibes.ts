import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { CatalogTrack, VibeId } from '@spotibay/shared';
import type { Db } from '../db/client.js';
import { listenHistory, tracks } from '../db/schema.js';
import { logger } from '../logger.js';
import { CatalogError, type CatalogService } from './catalog.js';
import type { CatalogMatchStore } from './search.js';
import type { SettingsService } from './settings.js';

/**
 * Each vibe's songs come from playlists Deezer's own editors keep up to date. If one of these goes
 * away, the editors' playlists found by `search` stand in for it.
 */
const VIBE_SOURCES: Record<Exclude<VibeId, 'trending'>, { playlists: string[]; search: string }> = {
  // Running Hits, Workout, Party Hits
  'work-mode': { playlists: ['1358731495', '2153050122', '2097558104'], search: 'workout' },
  // Soul to Chill, Acoustic Soul, Late Night Soul
  chillero: { playlists: ['1907881662', '1914376522', '3798764802'], search: 'chill soul' },
  // heartbreak </3, Sad Pop, super sad
  'ultimate-relapse': {
    playlists: ['14693592561', '8616373542', '1910358422'],
    search: 'sad songs',
  },
  // 80s Hits, 90s Hits, 00s Pop
  throwback: { playlists: ['867825522', '878989033', '8326097522'], search: '90s hits' },
  // Focus, study lofi, Calm Piano
  focus: { playlists: ['8749343942', '8749345882', '4590807924'], search: 'focus' },
};

const SONGS = 20;
const MAX_PER_ARTIST = 2;
/** Recent plays whose artists count as someone's favourites. */
const FAVORITE_PLAYS = 100;
/**
 * On top of a shuffle that changes daily (a number from 0 to 1): songs by artists you play, and
 * songs that already have a video (they start at once and cost no YouTube search).
 */
const FAVORITE_BOOST = 0.4;
const KNOWN_BOOST = 0.3;

export interface VibeServiceDeps {
  db: Db;
  catalog: Pick<CatalogService, 'playlistTracks' | 'editorialPlaylists' | 'topCharts'>;
  matches: Pick<CatalogMatchStore, 'findMany'>;
  settings: Pick<SettingsService, 'get'>;
  now?: () => Date;
}

/** FNV-1a hash of `text` as a number from 0 to 1: the same text always gives the same number. */
function unitHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x1_0000_0000;
}

/**
 * Songs for a mood or genre, to start a room from. Costs no YouTube quota: song info is from
 * Deezer, and a video is only looked for when someone picks a song.
 */
export function createVibeService({
  db,
  catalog,
  matches,
  settings,
  now = () => new Date(),
}: VibeServiceDeps) {
  /** Every song on the vibe's playlists, without repeats. */
  async function pool(id: Exclude<VibeId, 'trending'>): Promise<CatalogTrack[]> {
    const { playlists, search } = VIBE_SOURCES[id];
    const lists: CatalogTrack[][] = [];
    let missing = 0;
    for (const playlistId of playlists) {
      try {
        lists.push(await catalog.playlistTracks(playlistId));
      } catch (err) {
        if (!(err instanceof CatalogError) || err.code !== 'not_found') throw err;
        logger.warn({ vibe: id, playlistId }, 'vibe playlist is gone');
        missing++;
      }
    }
    if (missing > 0) {
      const standIns = (await catalog.editorialPlaylists(search)).filter(
        (p) => !playlists.includes(p),
      );
      for (const playlistId of standIns.slice(0, missing)) {
        lists.push(await catalog.playlistTracks(playlistId).catch(() => []));
      }
    }
    const seen = new Set<string>();
    return lists.flat().filter((s) => !seen.has(s.id) && seen.add(s.id));
  }

  /** Artists (lowercase) someone played lately. */
  async function favoriteArtists(userId: string): Promise<Set<string>> {
    const rows = await db
      .select({ artist: tracks.channelTitle })
      .from(listenHistory)
      .innerJoin(tracks, eq(tracks.videoId, listenHistory.videoId))
      .where(and(eq(listenHistory.userId, userId), isNotNull(tracks.catalogId)))
      .orderBy(desc(listenHistory.id))
      .limit(FAVORITE_PLAYS);
    return new Set(rows.map((r) => r.artist.toLowerCase()));
  }

  return {
    /** Vibes come from the catalog, so they're off when catalog search is. */
    enabled: () => settings.get('features.catalogSearch'),

    /**
     * Songs for the vibe, a fresh mix each day (and a different one per person), at most two per
     * artist. `trending` is the region's chart in its own order.
     */
    async forVibe(id: VibeId, userId: string): Promise<CatalogTrack[]> {
      if (id === 'trending') return (await catalog.topCharts()).songs.slice(0, SONGS);
      const songs = await pool(id);
      const [known, favorites] = await Promise.all([
        matches.findMany(songs.map((s) => s.id)),
        favoriteArtists(userId),
      ]);
      const day = now().toISOString().slice(0, 10);
      const ranked = songs
        .map((song) => ({
          song,
          score:
            unitHash(`${day}:${userId}:${id}:${song.id}`) +
            (favorites.has(song.artist.toLowerCase()) ? FAVORITE_BOOST : 0) +
            (known.has(song.id) ? KNOWN_BOOST : 0),
        }))
        .sort((a, b) => b.score - a.score);
      const perArtist = new Map<string, number>();
      const picked: CatalogTrack[] = [];
      for (const { song } of ranked) {
        const artist = song.artist.toLowerCase();
        const count = perArtist.get(artist) ?? 0;
        if (count >= MAX_PER_ARTIST) continue;
        perArtist.set(artist, count + 1);
        picked.push(song);
        if (picked.length === SONGS) break;
      }
      return picked;
    },
  };
}

export type VibeService = ReturnType<typeof createVibeService>;
