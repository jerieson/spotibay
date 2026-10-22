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

/** Skip votes are per track and cleared when it ends; the TTL only catches leftovers. */
const SKIP_VOTES_TTL_SEC = 6 * 60 * 60;

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
    await redis.del(playbackKey(roomId));
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
    await redis.del(skipVotesKey(roomId, queueItemId));
  }

  return { load, save, clear, nowPlaying, addSkipVote, skipVoters, clearSkipVotes };
}

export type PlaybackStore = ReturnType<typeof createPlaybackStore>;
