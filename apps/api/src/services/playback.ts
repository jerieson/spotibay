import {
  expectedPositionMs,
  moveItem,
  orderQueue,
  queueScore,
  skipVotesNeeded,
  type AddManyResult,
  type HistoryEntry,
  type PlaybackState,
  type QueueItem,
  type QueueMode,
  type RoomRole,
  type SettingKey,
  type SettingsValues,
  type SkipVotes,
  type VoteValue,
} from '@spotibay/shared';
import { createKeyedLock } from '../lib/keyed-lock.js';
import type { Presence } from './presence.js';
import type { PlaybackStore } from './playback-store.js';
import type { ActiveQueueItem, FinalStatus, QueueStore } from './queue-store.js';
import {
  parseVideoId,
  youtubeFailureMessage,
  YouTubeError,
  type YouTubeService,
} from './youtube.js';
import type { RoomService } from './rooms.js';
import { logger } from '../logger.js';

export type PlaybackErrorCode =
  | 'invalid_video'
  | 'track_rejected'
  | 'queue_limit'
  | 'duplicate_track'
  | 'youtube_unavailable'
  | 'rate_limited'
  | 'forbidden';

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
  youtube: Pick<YouTubeService, 'getVideos'>;
  presence: Presence;
  rooms: RoomService;
  settings: { get<K extends SettingKey>(key: K): SettingsValues[K] };
  now?: () => number;
  onError?: (err: unknown) => void;
}

export interface RoomSnapshot {
  playback: PlaybackState;
  queue: QueueItem[];
  skipVotes: SkipVotes;
}

const HISTORY_LIMIT = 50;

/** The queued rows in play order, as items. */
function playOrder(
  rows: ActiveQueueItem[],
  mode: QueueMode,
  /** Whose turn it was; defaults to the owner of the item playing now. */
  playingBy: string | null = rows.find((r) => r.status === 'playing')?.item.addedBy.userId ?? null,
): QueueItem[] {
  return orderQueue(
    rows
      .filter((r) => r.status === 'queued')
      .map((r) => ({
        id: r.item.id,
        addedBy: r.item.addedBy.userId,
        position: r.position,
        score: queueScore(r.item),
        item: r.item,
      })),
    mode,
    { playingBy },
  ).map((o) => o.item);
}

type EndReason = 'ended' | 'skipped' | 'unavailable';

export interface TrackChange {
  reason: EndReason;
  /** The item that just ended, if any. */
  previous: QueueItem | null;
  /** The item that started, if any. */
  next: QueueItem | null;
}

export function createPlaybackService({
  store,
  queue,
  youtube,
  presence,
  rooms,
  settings,
  now = Date.now,
  onError = (err) => logger.error({ err }, 'room service error'),
}: PlaybackServiceDeps) {
  const withLock = createKeyedLock();
  const timers = new Map<string, NodeJS.Timeout>();
  const playbackListeners = new Set<(roomId: string, state: PlaybackState) => void>();
  const queueListeners = new Set<(roomId: string, queue: QueueItem[]) => void>();
  const skipVoteListeners = new Set<(roomId: string, votes: SkipVotes) => void>();
  const trackChangeListeners = new Set<(roomId: string, change: TrackChange) => void>();

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

  async function upcoming(roomId: string, playingBy?: string | null): Promise<QueueItem[]> {
    const [rows, room] = await Promise.all([queue.listActive(roomId), rooms.findById(roomId)]);
    return playOrder(rows, room?.queueMode ?? 'fifo', playingBy);
  }

  async function publishQueue(roomId: string) {
    const items = await upcoming(roomId);
    for (const listener of queueListeners) listener(roomId, items);
  }

  /** Skip votes for the current track, counting only people still in the room. */
  async function currentSkipVotes(roomId: string): Promise<SkipVotes> {
    const [state, members] = await Promise.all([store.load(roomId), presence.list(roomId)]);
    const needed = skipVotesNeeded(members.length, settings.get('queue.skipVoteThreshold'));
    if (!state.item) return { queueItemId: null, voters: [], needed };
    const present = new Set(members.map((m) => m.userId));
    const voters = (await store.skipVoters(roomId, state.item.id)).filter((id) => present.has(id));
    return { queueItemId: state.item.id, voters, needed };
  }

  async function publishSkipVotes(roomId: string) {
    const votes = await currentSkipVotes(roomId);
    for (const listener of skipVoteListeners) listener(roomId, votes);
  }

  /** Skips if the votes reached the threshold, otherwise tells the room where they stand. Lock held. */
  async function settleSkipVotes(roomId: string) {
    const votes = await currentSkipVotes(roomId);
    if (votes.queueItemId && votes.voters.length >= votes.needed) await advance(roomId, 'skipped');
    else for (const listener of skipVoteListeners) listener(roomId, votes);
  }

  /** Ends the current item (if any) and starts the next queued one. Call with the room lock held. */
  async function advance(roomId: string, reason: EndReason) {
    const current = await store.load(roomId);
    const at = new Date(now());
    if (current.item) {
      await store.clearSkipVotes(roomId, current.item.id);
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
    // The item that just ended is no longer "playing", but its owner still just had a turn.
    const next = (await upcoming(roomId, current.item?.addedBy.userId ?? null))[0];
    if (next) {
      await queue.markPlaying(next.id, at);
      await publishPlayback(roomId, {
        status: 'playing',
        item: next,
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
    await publishSkipVotes(roomId);
    const change: TrackChange = { reason, previous: current.item, next: next ?? null };
    for (const listener of trackChangeListeners) listener(roomId, change);
  }

  async function snapshot(roomId: string): Promise<RoomSnapshot> {
    const [playback, items, skipVotes] = await Promise.all([
      store.load(roomId),
      upcoming(roomId),
      currentSkipVotes(roomId),
    ]);
    return { playback, queue: items, skipVotes };
  }

  async function fetchTracks(videoIds: string[], userId: string) {
    try {
      return await youtube.getVideos(videoIds, userId);
    } catch (err) {
      if (err instanceof YouTubeError) {
        if (err.code === 'user_limit') throw new PlaybackError('rate_limited', err.message);
        throw new PlaybackError('youtube_unavailable', youtubeFailureMessage(err));
      }
      throw err;
    }
  }

  async function add(roomId: string, userId: string, input: string): Promise<QueueItem> {
    const videoId = parseVideoId(input);
    if (!videoId) throw new PlaybackError('invalid_video', 'That is not a YouTube link');

    const track = (await fetchTracks([videoId], userId)).get(videoId);
    if (!track) throw new PlaybackError('invalid_video', 'That video was not found');
    if (!track.embeddable) {
      throw new PlaybackError('track_rejected', 'That video cannot be played outside YouTube');
    }
    if ((await store.unplayable(roomId, [videoId])).has(videoId)) {
      throw new PlaybackError('track_rejected', 'That video could not be played in this room');
    }
    if (track.durationSec === 0) {
      throw new PlaybackError('track_rejected', 'Live streams cannot be added');
    }

    return withLock(roomId, async () => {
      const active = await queue.listActive(roomId);
      if (active.length >= settings.get('limits.maxQueueLength')) {
        throw new PlaybackError(
          'queue_limit',
          'The queue is full. Add more once a few songs play.',
        );
      }
      if (active.some((r) => r.item.track.videoId === videoId)) {
        throw new PlaybackError('duplicate_track', 'That track is already in the queue');
      }
      const mine = active.filter((r) => r.status === 'queued' && r.item.addedBy.userId === userId);
      if (mine.length >= settings.get('limits.maxQueueItemsPerUser')) {
        throw new PlaybackError(
          'queue_limit',
          `You already have ${mine.length} songs waiting. Add more once one of them plays.`,
        );
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

  function voteSkip(roomId: string, userId: string): Promise<void> {
    return withLock(roomId, async () => {
      const state = await store.load(roomId);
      if (!state.item) return;
      await store.addSkipVote(roomId, state.item.id, userId);
      await settleSkipVotes(roomId);
    });
  }

  /** Re-evaluates skip votes after the member list changed: the threshold may now be met. */
  function refreshSkipVotes(roomId: string): Promise<void> {
    return withLock(roomId, () => settleSkipVotes(roomId));
  }

  function vote(
    roomId: string,
    userId: string,
    queueItemId: string,
    value: VoteValue | 0,
  ): Promise<void> {
    return withLock(roomId, async () => {
      const rows = await queue.listActive(roomId);
      if (rows.some((r) => r.status === 'queued' && r.item.id === queueItemId)) {
        await queue.setVote(queueItemId, userId, value);
      }
      await publishQueue(roomId);
    });
  }

  /** Listeners can remove their own items; the host and DJs can remove any. */
  function remove(
    roomId: string,
    userId: string,
    role: RoomRole,
    queueItemId: string,
  ): Promise<void> {
    return withLock(roomId, async () => {
      const row = (await queue.listActive(roomId)).find(
        (r) => r.status === 'queued' && r.item.id === queueItemId,
      );
      if (row) {
        if (role === 'listener' && row.item.addedBy.userId !== userId) {
          throw new PlaybackError('forbidden', 'You can only remove your own tracks');
        }
        await queue.finish(queueItemId, 'removed', new Date(now()));
      }
      await publishQueue(roomId);
    });
  }

  /** Moves an item to `toIndex` of the play order and makes that order the new base order. */
  function reorder(roomId: string, queueItemId: string, toIndex: number): Promise<void> {
    return withLock(roomId, async () => {
      const ordered = await upcoming(roomId);
      if (ordered.some((i) => i.id === queueItemId)) {
        const moved = moveItem(ordered, queueItemId, toIndex);
        await queue.setPositions(
          roomId,
          moved.map((i) => i.id),
        );
      }
      await publishQueue(roomId);
    });
  }

  /**
   * Queues many videos at once (a playlist, liked songs). Tracks that can't be queued are counted,
   * not fatal. Hosts and DJs are exempt from the per-user limit; the room limit applies to everyone.
   */
  async function addMany(
    roomId: string,
    userId: string,
    role: RoomRole,
    videoIds: string[],
  ): Promise<AddManyResult> {
    const wanted = [...new Set(videoIds)];
    const found = await fetchTracks(wanted, userId);
    const failedHere = await store.unplayable(roomId, wanted);
    const result: AddManyResult = { added: 0, duplicates: 0, unplayable: 0, overLimit: 0 };
    return withLock(roomId, async () => {
      const active = await queue.listActive(roomId);
      const inQueue = new Set(active.map((r) => r.item.track.videoId));
      let total = active.length;
      let mine = active.filter(
        (r) => r.status === 'queued' && r.item.addedBy.userId === userId,
      ).length;
      const maxTotal = settings.get('limits.maxQueueLength');
      const maxMine = settings.get('limits.maxQueueItemsPerUser');
      const exempt = role !== 'listener';
      // On an idle room the first track starts playing at once, so it doesn't count as queued.
      let startsNow = (await store.load(roomId)).status === 'idle';
      for (const videoId of wanted) {
        const track = found.get(videoId);
        if (!track || !track.embeddable || failedHere.has(videoId) || track.durationSec === 0) {
          result.unplayable += 1;
        } else if (inQueue.has(videoId)) {
          result.duplicates += 1;
        } else if (total >= maxTotal || (!exempt && mine >= maxMine)) {
          result.overLimit += 1;
        } else {
          await queue.insert({ roomId, videoId, addedBy: userId });
          inQueue.add(videoId);
          total += 1;
          if (startsNow) startsNow = false;
          else mine += 1;
          result.added += 1;
        }
      }
      if (result.added > 0) {
        if ((await store.load(roomId)).status === 'idle') await advance(roomId, 'ended');
        else await publishQueue(roomId);
      }
      return result;
    });
  }

  function history(roomId: string): Promise<HistoryEntry[]> {
    return queue.listHistory(roomId, HISTORY_LIMIT);
  }

  /**
   * A client's player could not play the item. A report from the host or a DJ moves on at once
   * (they can skip anyway); listeners need as many reports as a vote skip, so one listener can't
   * skip at will. The video is then kept out of this room only, never flagged for every room.
   */
  function reportUnavailable(
    roomId: string,
    userId: string,
    role: RoomRole,
    queueItemId: string,
  ): Promise<void> {
    return withLock(roomId, async () => {
      const state = await store.load(roomId);
      if (state.item?.id !== queueItemId) return;
      if (role === 'listener') {
        await store.addUnavailableReport(roomId, queueItemId, userId);
        const [members, reporters] = await Promise.all([
          presence.list(roomId),
          store.unavailableReporters(roomId, queueItemId),
        ]);
        const present = new Set(members.map((m) => m.userId));
        const needed = skipVotesNeeded(members.length, settings.get('queue.skipVoteThreshold'));
        if (reporters.filter((id) => present.has(id)).length < needed) return;
      }
      await store.markUnplayable(roomId, state.item.track.videoId);
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
    offUpdated();
  }

  const offClosed = rooms.onClosed((row) => {
    forget(row.id).catch(onError);
  });

  // A queue-mode change reorders what everyone sees.
  const offUpdated = rooms.onUpdated((row) => {
    publishQueue(row.id).catch(onError);
  });

  return {
    snapshot,
    add,
    addMany,
    vote,
    remove,
    reorder,
    voteSkip,
    refreshSkipVotes,
    history,
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
    onSkipVotes(listener: (roomId: string, votes: SkipVotes) => void) {
      skipVoteListeners.add(listener);
      return () => skipVoteListeners.delete(listener);
    },
    onTrackChange(listener: (roomId: string, change: TrackChange) => void) {
      trackChangeListeners.add(listener);
      return () => trackChangeListeners.delete(listener);
    },
    onQueue(listener: (roomId: string, queue: QueueItem[]) => void) {
      queueListeners.add(listener);
      return () => queueListeners.delete(listener);
    },
  };
}

export type PlaybackService = ReturnType<typeof createPlaybackService>;
