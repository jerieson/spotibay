import type { SettingsService } from './settings.js';
import type { PlaybackService } from './playback.js';
import type { Presence } from './presence.js';
import type { RecommendationService } from './recommendations.js';
import type { RoomService } from './rooms.js';
import type { SearchService } from './search.js';
import { logger } from '../logger.js';

/** Songs tried per fill. Matches someone already made are free; the rest ask the link sources. */
const MAX_TRIES = 6;
/** Videos autoplay picked lately in a room, kept out so a skipped pick doesn't come straight back. */
const RECENT_PICKS = 50;

export interface AutoplayServiceDeps {
  playback: Pick<PlaybackService, 'snapshot' | 'history' | 'addAutoplay' | 'onTrackChange'>;
  rooms: Pick<RoomService, 'findById' | 'onUpdated' | 'onClosed'>;
  presence: Pick<Presence, 'count'>;
  recommendations: Pick<RecommendationService, 'forRoom'>;
  matcher: Pick<SearchService, 'matchWithoutSearch'>;
  settings: Pick<SettingsService, 'get'>;
  onError?: (err: unknown) => void;
}

/**
 * Keeps one song queued in rooms with autoplay on: when a track starts (or the room goes quiet)
 * with nothing after it, a song related to what the room played lately is queued, credited to the
 * host. Matching never runs a YouTube search, so autoplay costs at most a unit of quota per song.
 */
export function createAutoplayService({
  playback,
  rooms,
  presence,
  recommendations,
  matcher,
  settings,
  onError = (err) => logger.error({ err }, 'autoplay failed'),
}: AutoplayServiceDeps) {
  /** Rooms being filled now -> whether another fill was asked for meanwhile. */
  const running = new Map<string, boolean>();
  const recentPicks = new Map<string, string[]>();

  function remember(roomId: string, videoId: string) {
    const picks = [...(recentPicks.get(roomId) ?? []), videoId];
    recentPicks.set(roomId, picks.slice(-RECENT_PICKS));
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

    let tries = 0;
    for (const song of await recommendations.forRoom(roomId)) {
      if (tries++ >= MAX_TRIES) return;
      const track = await matcher.matchWithoutSearch(song);
      if (!track || skip.has(track.videoId)) continue;
      remember(roomId, track.videoId);
      const added = await playback.addAutoplay(roomId, track.videoId);
      // Queued, or no longer wanted (turned off, someone added a song): either way, done.
      if (added !== 'unplayable') return;
    }
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
