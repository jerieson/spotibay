import { z } from 'zod';
import { avatarSchema } from './identity.js';

export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
export const MAX_QUEUE_URL_LENGTH = 300;

export const trackSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  channelTitle: z.string(),
  thumbnailUrl: z.string(),
  durationSec: z.number().int().nonnegative(),
});
export type Track = z.infer<typeof trackSchema>;

export const queuePersonSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  avatar: avatarSchema,
});
export type QueuePerson = z.infer<typeof queuePersonSchema>;

export const queueItemSchema = z.object({
  id: z.string(),
  track: trackSchema,
  addedBy: queuePersonSchema,
});
export type QueueItem = z.infer<typeof queueItemSchema>;

export const playbackStatusSchema = z.enum(['playing', 'paused', 'idle']);
export type PlaybackStatus = z.infer<typeof playbackStatusSchema>;

/**
 * Where the room's current track is. While `playing`, the position at server time `t` is
 * `positionMs + (t - refServerTime)`; otherwise it is `positionMs`.
 */
export const playbackStateSchema = z.object({
  status: playbackStatusSchema,
  item: queueItemSchema.nullable(),
  positionMs: z.number().int().nonnegative(),
  refServerTime: z.number(),
  /** Bumps on every change so clients can drop stale updates. */
  version: z.number().int().nonnegative(),
});
export type PlaybackState = z.infer<typeof playbackStateSchema>;

export const syncConfigSchema = z.object({
  driftThresholdMs: z.number().int().positive(),
  checkIntervalMs: z.number().int().positive(),
});
export type SyncConfig = z.infer<typeof syncConfigSchema>;

export const idlePlayback: PlaybackState = {
  status: 'idle',
  item: null,
  positionMs: 0,
  refServerTime: 0,
  version: 0,
};

/** Where playback is at `serverNow` (epoch ms on the server's clock). */
export function expectedPositionMs(state: PlaybackState, serverNow: number): number {
  if (state.status !== 'playing') return state.positionMs;
  const position = state.positionMs + Math.max(0, serverNow - state.refServerTime);
  return state.item ? Math.min(position, state.item.track.durationSec * 1000) : position;
}
