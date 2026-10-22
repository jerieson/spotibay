import {
  expectedPositionMs,
  type PlaybackState,
  type QueueItem,
  type SettingKey,
  type SettingsValues,
} from '@spotibay/shared';
import { createKeyedLock } from '../lib/keyed-lock.js';
import type { Presence } from './presence.js';
import type { PlaybackStore } from './playback-store.js';
import type { FinalStatus, QueueStore } from './queue-store.js';
import { parseVideoId, YouTubeError, type YouTubeService } from './youtube.js';
import type { RoomService } from './rooms.js';

export type PlaybackErrorCode =
  'invalid_video' | 'track_rejected' | 'queue_limit' | 'youtube_unavailable' | 'forbidden';

export class PlaybackError extends Error {
  constructor(
    readonly code: PlaybackErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PlaybackError';
  }
}

export interface PlaybackServiceDeps {
  store: PlaybackStore;
  queue: QueueStore;
  youtube: Pick<YouTubeService, 'getVideos' | 'markUnembeddable'>;
  presence: Presence;
  rooms: RoomService;
  settings: { get<K extends SettingKey>(key: K): SettingsValues[K] };
  now?: () => number;
  onError?: (err: unknown) => void;
}

export interface RoomSnapshot {
  playback: PlaybackState;
  queue: QueueItem[];
}

type EndReason = 'ended' | 'skipped' | 'unavailable';

export function createPlaybackService({
  store,
  queue,
  youtube,
  presence,
  rooms,
  settings,
  now = Date.now,
  onError = (err) => console.error(err),
}: PlaybackServiceDeps) {
  const withLock = createKeyedLock();
  const timers = new Map<string, NodeJS.Timeout>();
  const playbackListeners = new Set<(roomId: string, state: PlaybackState) => void>();
  const queueListeners = new Set<(roomId: string, queue: QueueItem[]) => void>();

  function clearTimer(roomId: string) {
    const timer = timers.get(roomId);
    if (timer) clearTimeout(timer);
    timers.delete(roomId);
  }

  /** The server owns track end: fire when the remaining time runs out, unless state moved on. */
  function scheduleEnd(roomId: string, state: PlaybackState) {
    clearTimer(roomId);
    if (state.status !== 'playing' || !state.item) return;
    const itemId = state.item.id;
    const remaining = state.item.track.durationSec * 1000 - expectedPositionMs(state, now());
    const timer = setTimeout(
      () => {
        timers.delete(roomId);
        withLock(roomId, async () => {
          const current = await store.load(roomId);
          if (current.item?.id === itemId && current.status === 'playing') {
            await advance(roomId, 'ended');
          }
        }).catch(onError);
      },
      Math.max(0, remaining),
    );
    timer.unref();
    timers.set(roomId, timer);
  }

  async function publishPlayback(roomId: string, state: PlaybackState) {
    await store.save(roomId, state);
    scheduleEnd(roomId, state);
    for (const listener of playbackListeners) listener(roomId, state);
  }

  async function upcoming(roomId: string): Promise<QueueItem[]> {
    return (await queue.listActive(roomId)).filter((r) => r.status === 'queued').map((r) => r.item);
  }

  async function publishQueue(roomId: string) {
    const items = await upcoming(roomId);
    for (const listener of queueListeners) listener(roomId, items);
  }

  /** Ends the current item (if any) and starts the next queued one. Call with the room lock held. */
  async function advance(roomId: string, reason: EndReason) {
    const current = await store.load(roomId);
    const at = new Date(now());
    if (current.item) {
      const status: FinalStatus = reason === 'ended' ? 'played' : 'skipped';
      await queue.finish(current.item.id, status, at);
      if (reason === 'ended') {
        const members = await presence.list(roomId);
        await queue.recordHistory({
          roomId,
          videoId: current.item.track.videoId,
          userIds: members.map((m) => m.userId),
          playedAt: at,
        });
      }
    }
    const next = (await queue.listActive(roomId)).find((r) => r.status === 'queued');
    if (next) {
      await queue.markPlaying(next.item.id, at);
      await publishPlayback(roomId, {
        status: 'playing',
        item: next.item,
        positionMs: 0,
        refServerTime: now(),
        version: current.version + 1,
      });
    } else {
      await publishPlayback(roomId, {
        status: 'idle',
        item: null,
        positionMs: 0,
        refServerTime: now(),
        version: current.version + 1,
      });
    }
    await publishQueue(roomId);
  }

  async function snapshot(roomId: string): Promise<RoomSnapshot> {
    const [playback, items] = await Promise.all([store.load(roomId), upcoming(roomId)]);
    return { playback, queue: items };
  }

  async function add(roomId: string, userId: string, input: string): Promise<QueueItem> {
    const videoId = parseVideoId(input);
    if (!videoId) throw new PlaybackError('invalid_video', 'That is not a YouTube link');

    let track;
    try {
      track = (await youtube.getVideos([videoId])).get(videoId);
    } catch (err) {
      if (err instanceof YouTubeError) {
        throw new PlaybackError(
          'youtube_unavailable',
          err.code === 'not_configured'
            ? 'Adding tracks is not set up on this server'
            : 'Could not reach YouTube, try again in a moment',
        );
      }
      throw err;
    }
    if (!track) throw new PlaybackError('invalid_video', 'That video was not found');
    if (!track.embeddable) {
      throw new PlaybackError('track_rejected', 'That video cannot be played outside YouTube');
    }
    if (track.durationSec === 0) {
      throw new PlaybackError('track_rejected', 'Live streams cannot be added');
    }
    const maxSec = settings.get('limits.maxTrackDurationSec');
    if (track.durationSec > maxSec) {
      throw new PlaybackError(
        'track_rejected',
        `Tracks can be at most ${Math.floor(maxSec / 60)} minutes long`,
      );
    }

    return withLock(roomId, async () => {
      const active = await queue.listActive(roomId);
      if (active.length >= settings.get('limits.maxQueueLength')) {
        throw new PlaybackError('queue_limit', 'The queue is full');
      }
      const mine = active.filter((r) => r.status === 'queued' && r.item.addedBy.userId === userId);
      if (mine.length >= settings.get('limits.maxQueueItemsPerUser')) {
        throw new PlaybackError('queue_limit', 'You have too many tracks in the queue');
      }
      const item = await queue.insert({ roomId, videoId, addedBy: userId });
      if (!item) throw new Error('queue insert returned no row');
      if ((await store.load(roomId)).status === 'idle') await advance(roomId, 'ended');
      else await publishQueue(roomId);
      return item;
    });
  }

  function play(roomId: string): Promise<void> {
    return withLock(roomId, async () => {
      const state = await store.load(roomId);
      if (state.status === 'paused') {
        await publishPlayback(roomId, {
          ...state,
          status: 'playing',
          refServerTime: now(),
          version: state.version + 1,
        });
      } else if (state.status === 'idle') {
        if ((await upcoming(roomId)).length > 0) await advance(roomId, 'ended');
      }
    });
  }

  function pause(roomId: string): Promise<void> {
    return withLock(roomId, async () => {
      const state = await store.load(roomId);
      if (state.status !== 'playing') return;
      await publishPlayback(roomId, {
        ...state,
        status: 'paused',
        positionMs: expectedPositionMs(state, now()),
        refServerTime: now(),
        version: state.version + 1,
      });
    });
  }

  function seek(roomId: string, positionMs: number): Promise<void> {
    return withLock(roomId, async () => {
      const state = await store.load(roomId);
      if (!state.item) return;
      await publishPlayback(roomId, {
        ...state,
        positionMs: Math.min(positionMs, state.item.track.durationSec * 1000),
        refServerTime: now(),
        version: state.version + 1,
      });
    });
  }

  function skip(roomId: string): Promise<void> {
    return withLock(roomId, async () => {
      if ((await store.load(roomId)).item) await advance(roomId, 'skipped');
    });
  }

  /** A client's player could not play the item: remember that and move on, once. */
  function reportUnavailable(roomId: string, queueItemId: string): Promise<void> {
    return withLock(roomId, async () => {
      const state = await store.load(roomId);
      if (state.item?.id !== queueItemId) return;
      await youtube.markUnembeddable(state.item.track.videoId);
      await advance(roomId, 'unavailable');
    });
  }

  /** Drops a closed room's live state. */
  async function forget(roomId: string) {
    clearTimer(roomId);
    await store.clear(roomId);
  }

  /** Re-arms end timers from Redis after a restart; tracks that ended in the meantime advance now. */
  async function start() {
    for (const row of await rooms.listOpen()) {
      await withLock(row.id, async () => {
        const state = await store.load(row.id);
        if (state.status === 'playing' && state.item) {
          if (expectedPositionMs(state, now()) >= state.item.track.durationSec * 1000) {
            await advance(row.id, 'ended');
          } else {
            scheduleEnd(row.id, state);
          }
        } else if (state.status === 'idle' && (await upcoming(row.id)).length > 0) {
          await advance(row.id, 'ended');
        }
      });
    }
  }

  function stop() {
    for (const roomId of [...timers.keys()]) clearTimer(roomId);
    offClosed();
  }

  const offClosed = rooms.onClosed((row) => {
    forget(row.id).catch(onError);
  });

  return {
    snapshot,
    add,
    play,
    pause,
    seek,
    skip,
    reportUnavailable,
    start,
    stop,
    onPlayback(listener: (roomId: string, state: PlaybackState) => void) {
      playbackListeners.add(listener);
      return () => playbackListeners.delete(listener);
    },
    onQueue(listener: (roomId: string, queue: QueueItem[]) => void) {
      queueListeners.add(listener);
      return () => queueListeners.delete(listener);
    },
  };
}

export type PlaybackService = ReturnType<typeof createPlaybackService>;
