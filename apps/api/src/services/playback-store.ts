import type { Redis } from 'ioredis';
import {
  idlePlayback,
  playbackStateSchema,
  type NowPlaying,
  type PlaybackState,
} from '@spotibay/shared';

export const playbackKey = (roomId: string) => `room:${roomId}:playback`;
export const skipVotesKey = (roomId: string, queueItemId: string) =>
  `room:${roomId}:skipvotes:${queueItemId}`;
export const unavailableReportsKey = (roomId: string, queueItemId: string) =>
  `room:${roomId}:unavailable:${queueItemId}`;
/** Videos a room's players could not play; scoped to the room so reports can't block them elsewhere. */
export const unplayableKey = (roomId: string) => `room:${roomId}:unplayable`;

/** Skip votes are per track and cleared when it ends; the TTL only catches leftovers. */
const SKIP_VOTES_TTL_SEC = 6 * 60 * 60;
/** A video that failed in a room is kept out of it for a day; it may play again once YouTube allows it. */
const UNPLAYABLE_TTL_SEC = 24 * 60 * 60;

/** Reads and writes the `room:{id}:playback` hash. */
export function createPlaybackStore(redis: Redis) {
  async function load(roomId: string): Promise<PlaybackState> {
    const h = await redis.hgetall(playbackKey(roomId));
    if (!h.status) return idlePlayback;
    let item: unknown;
    try {
      item = h.item ? JSON.parse(h.item) : null;
    } catch {
      return idlePlayback;
    }
    const parsed = playbackStateSchema.safeParse({
      status: h.status,
      item,
      positionMs: Number(h.positionMs),
      refServerTime: Number(h.refServerTime),
      version: Number(h.version),
    });
    return parsed.success ? parsed.data : idlePlayback;
  }

  async function save(roomId: string, state: PlaybackState): Promise<void> {
    await redis.hset(playbackKey(roomId), {
      queueItemId: state.item?.id ?? '',
      videoId: state.item?.track.videoId ?? '',
      status: state.status,
      positionMs: state.positionMs,
      refServerTime: state.refServerTime,
      version: state.version,
      item: state.item ? JSON.stringify(state.item) : '',
    });
  }

  async function clear(roomId: string): Promise<void> {
    await redis.del(playbackKey(roomId), unplayableKey(roomId));
  }

  async function nowPlaying(roomId: string): Promise<NowPlaying | null> {
    const { item } = await load(roomId);
    if (!item) return null;
    const { videoId, title, channelTitle, thumbnailUrl } = item.track;
    return { videoId, title, channelTitle, thumbnailUrl };
  }

  async function addSkipVote(roomId: string, queueItemId: string, userId: string) {
    const key = skipVotesKey(roomId, queueItemId);
    await redis.sadd(key, userId);
    await redis.expire(key, SKIP_VOTES_TTL_SEC);
  }

  function skipVoters(roomId: string, queueItemId: string): Promise<string[]> {
    return redis.smembers(skipVotesKey(roomId, queueItemId));
  }

  async function clearSkipVotes(roomId: string, queueItemId: string) {
    await redis.del(skipVotesKey(roomId, queueItemId), unavailableReportsKey(roomId, queueItemId));
  }

  async function addUnavailableReport(roomId: string, queueItemId: string, userId: string) {
    const key = unavailableReportsKey(roomId, queueItemId);
    await redis.sadd(key, userId);
    await redis.expire(key, SKIP_VOTES_TTL_SEC);
  }

  function unavailableReporters(roomId: string, queueItemId: string): Promise<string[]> {
    return redis.smembers(unavailableReportsKey(roomId, queueItemId));
  }

  async function markUnplayable(roomId: string, videoId: string) {
    await redis.sadd(unplayableKey(roomId), videoId);
    await redis.expire(unplayableKey(roomId), UNPLAYABLE_TTL_SEC);
  }

  /** Which of `videoIds` this room could not play recently. */
  async function unplayable(roomId: string, videoIds: string[]): Promise<Set<string>> {
    if (videoIds.length === 0) return new Set();
    const flags = await redis.smismember(unplayableKey(roomId), ...videoIds);
    return new Set(videoIds.filter((_, i) => flags[i] === 1));
  }

  return {
    load,
    save,
    clear,
    nowPlaying,
    addSkipVote,
    skipVoters,
    clearSkipVotes,
    addUnavailableReport,
    unavailableReporters,
    markUnplayable,
    unplayable,
  };
}

export type PlaybackStore = ReturnType<typeof createPlaybackStore>;
