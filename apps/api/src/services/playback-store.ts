import type { Redis } from 'ioredis';
import {
  idlePlayback,
  playbackStateSchema,
  type NowPlaying,
  type PlaybackState,
} from '@spotibay/shared';

export const playbackKey = (roomId: string) => `room:${roomId}:playback`;

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

  return { load, save, clear, nowPlaying };
}

export type PlaybackStore = ReturnType<typeof createPlaybackStore>;
