import type { CatalogTrack } from '@spotibay/shared';
import type { Metrics } from '../lib/metrics.js';
import type { SettingsService } from './settings.js';
import type { PlaybackService } from './playback.js';
import type { Presence } from './presence.js';
import type { RecommendationService } from './recommendations.js';
import type { RoomService } from './rooms.js';
import type { SearchService } from './search.js';
import { logger } from '../logger.js';

/** Songs per list asked of the link sources; songs someone already matched don't count. */
const MAX_LINK_TRIES = 6;
/** Songs a fill may spend a YouTube search on once nothing free was found (each is capped daily). */
const MAX_SEARCH_TRIES = 2;
/** Videos autoplay picked lately in a room, kept out so a skipped pick doesn't come straight back. */
const RECENT_PICKS = 50;

export interface AutoplayServiceDeps {
  playback: Pick<PlaybackService, 'snapshot' | 'history' | 'addAutoplay' | 'onTrackChange'>;
  rooms: Pick<RoomService, 'findById' | 'onUpdated' | 'onClosed'>;
  presence: Pick<Presence, 'count'>;
  recommendations: Pick<RecommendationService, 'forRoom' | 'forUser'>;
  matcher: Pick<SearchService, 'matchWithoutSearch' | 'matchWithSearch' | 'knownAmong'>;
  settings: Pick<SettingsService, 'get'>;
  metrics?: Pick<Metrics, 'incr'>;
  onError?: (err: unknown) => void;
}

/**
 * Keeps one song queued in rooms with autoplay on: when a track starts (or the room goes quiet)
 * with nothing after it, a song is queued, credited to the host. Songs come from what the room
 * played lately, then from the host's own suggestions (the top chart before they have any).
 * Songs someone already matched to a video go first and cost nothing; then the link sources
 * (a unit of quota at most); only then a YouTube search, within `search.autoplaySearchesPerDay`.
 */
export function createAutoplayService({
  playback,
  rooms,
  presence,
  recommendations,
  matcher,
  settings,
  metrics,
  onError = (err) => logger.error({ err }, 'autoplay failed'),
}: AutoplayServiceDeps) {
  /** Rooms being filled now -> whether another fill was asked for meanwhile. */
  const running = new Map<string, boolean>();
  const recentPicks = new Map<string, string[]>();

  function remember(roomId: string, videoId: string) {
    const picks = [...(recentPicks.get(roomId) ?? []), videoId];
    recentPicks.set(roomId, picks.slice(-RECENT_PICKS));
  }

  /** The host's suggestions; none when the catalog is busy (the room's list was tried first). */
  async function hostSuggestions(ownerId: string): Promise<CatalogTrack[]> {
    try {
      return (await recommendations.forUser(ownerId)).suggestions;
    } catch (err) {
      logger.warn({ err }, "autoplay could not get the host's suggestions");
      return [];
    }
  }

  async function fillOnce(roomId: string): Promise<void> {
    if (!settings.get('features.autoplay')) return;
    const room = await rooms.findById(roomId);
    if (!room?.autoplay || room.closedAt) return;
    // Nobody is listening: let the room go quiet (and close once it's been empty a while).
    if ((await presence.count(roomId)) === 0) return;
    const { playback: state, queue } = await playback.snapshot(roomId);
    if (queue.length > 0) return;

    const skip = new Set([
      ...(await playback.history(roomId)).map((e) => e.track.videoId),
      ...(recentPicks.get(roomId) ?? []),
    ]);
    if (state.item) skip.add(state.item.track.videoId);

    /** Queues the video unless it was just played; `true` when the fill is done. */
    async function offer(videoId: string): Promise<boolean> {
      if (skip.has(videoId)) return false;
      skip.add(videoId);
      remember(roomId, videoId);
      const added = await playback.addAutoplay(roomId, videoId);
      if (added === 'unplayable') return false;
      // Queued, or no longer wanted (turned off, someone added a song): either way, done.
      if (typeof added !== 'string') await metrics?.incr('autoplay_queued');
      return true;
    }

    const seen = new Set<string>();
    /** Songs no free source had a video for, in the order they were wanted. */
    const unmatched: CatalogTrack[] = [];
    for (const load of [
      () => recommendations.forRoom(roomId),
      () => hostSuggestions(room.ownerId),
    ]) {
      const songs = (await load()).filter((s) => !seen.has(s.id));
      for (const s of songs) seen.add(s.id);
      const known = await matcher.knownAmong(songs.map((s) => s.id));
      const ordered = [
        ...songs.filter((s) => known.has(s.id)),
        ...songs.filter((s) => !known.has(s.id)),
      ];
      let linkTries = 0;
      for (const song of ordered) {
        if (!known.has(song.id) && linkTries++ >= MAX_LINK_TRIES) break;
        const track = await matcher.matchWithoutSearch(song);
        if (!track) unmatched.push(song);
        else if (await offer(track.videoId)) return;
      }
    }

    for (const song of unmatched.slice(0, MAX_SEARCH_TRIES)) {
      const track = await matcher.matchWithSearch(song);
      if (track && (await offer(track.videoId))) return;
    }
    await metrics?.incr('autoplay_none');
    logger.info({ roomId, tried: seen.size }, 'autoplay found nothing to queue');
  }

  /**
   * Fills the room's queue if it needs it. Runs in the background, outside the room lock; a call
   * while a fill is running makes it check once more when it finishes (a fill that starts an idle
   * room asks again, so the next song is queued too). Resolves when the room is settled.
   */
  function fill(roomId: string): Promise<void> {
    if (running.has(roomId)) {
      running.set(roomId, true);
      return Promise.resolve();
    }
    running.set(roomId, false);
    return (async () => {
      try {
        do {
          running.set(roomId, false);
          await fillOnce(roomId);
        } while (running.get(roomId));
      } catch (err) {
        onError(err);
      } finally {
        running.delete(roomId);
      }
    })();
  }

  const offTrackChange = playback.onTrackChange((roomId) => {
    void fill(roomId);
  });
  // Turning autoplay on with an empty queue (or a quiet room) fills it straight away.
  const offUpdated = rooms.onUpdated((row) => {
    if (row.autoplay) void fill(row.id);
  });
  const offClosed = rooms.onClosed((row) => {
    recentPicks.delete(row.id);
  });

  return {
    fill,
    stop() {
      offTrackChange();
      offUpdated();
      offClosed();
    },
  };
}

export type AutoplayService = ReturnType<typeof createAutoplayService>;
