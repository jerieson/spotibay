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

export const queueModeSchema = z.enum(['fifo', 'fair']);
export type QueueMode = z.infer<typeof queueModeSchema>;

export const voteValueSchema = z.union([z.literal(1), z.literal(-1)]);
export type VoteValue = z.infer<typeof voteValueSchema>;

export const queueItemSchema = z.object({
  id: z.string(),
  track: trackSchema,
  addedBy: queuePersonSchema,
  /** userId -> vote. */
  votes: z.record(z.string(), voteValueSchema).default({}),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

/** Sum of an item's votes. */
export function queueScore(item: Pick<QueueItem, 'votes'>): number {
  let score = 0;
  for (const value of Object.values(item.votes)) score += value;
  return score;
}

/** Who wants to skip the current track, and how many votes it takes. */
export const skipVotesSchema = z.object({
  queueItemId: z.string().nullable(),
  voters: z.array(z.string()),
  needed: z.number().int().positive(),
});
export type SkipVotes = z.infer<typeof skipVotesSchema>;

export const historyEntrySchema = z.object({
  id: z.string(),
  track: trackSchema,
  addedBy: queuePersonSchema,
  playedAt: z.string(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export const roomHistoryResponseSchema = z.object({ history: z.array(historyEntrySchema) });
export type RoomHistoryResponse = z.infer<typeof roomHistoryResponseSchema>;

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
