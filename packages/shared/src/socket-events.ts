import { z } from 'zod';
import {
  chatBodySchema,
  reactionEmojiSchema,
  type ChatMessage,
  type ChatReaction,
} from './chat.js';
import {
  MAX_QUEUE_URL_LENGTH,
  type PlaybackState,
  type QueueItem,
  type SkipVotes,
  voteValueSchema,
} from './playback.js';
import type { AdminStats, PublicSettingKey } from './admin.js';
import { MAX_BATCH_VIDEOS, videoIdSchema, type AddManyResult } from './playlists.js';
import {
  assignableRoleSchema,
  roomCodeSchema,
  roomPasswordSchema,
  updateRoomBodySchema,
  type Member,
  type Room,
  type RoomState,
} from './rooms.js';
import type { Announcement } from './settings.js';

export interface SettingsUpdate {
  key: PublicSettingKey;
  value: unknown;
  version: number;
}

export const socketErrorCodes = [
  'invalid_payload',
  'unauthenticated',
  'banned',
  'room_not_found',
  'room_closed',
  'wrong_password',
  'room_full',
  'not_in_room',
  'forbidden',
  'user_not_in_room',
  'maintenance',
  'invalid_video',
  'track_rejected',
  'queue_limit',
  'duplicate_track',
  'playlist_not_found',
  'youtube_unavailable',
  'rate_limited',
  'feature_disabled',
  'internal_error',
] as const;
export type SocketErrorCode = (typeof socketErrorCodes)[number];

export interface SocketError {
  code: SocketErrorCode;
  message: string;
}

/** Zod schemas for every inbound payload, keyed by event name. */
export const clientEventSchemas = {
  'time:ping': z.object({ t0: z.number() }),
  'room:join': z.object({
    code: roomCodeSchema,
    password: roomPasswordSchema.optional(),
    /** Join with host powers and skip the password. Honoured only for a signed-in admin. */
    asAdmin: z.boolean().optional(),
  }),
  'room:leave': z.undefined(),
  'room:update': updateRoomBodySchema,
  'room:setRole': z.object({ userId: z.string().min(1), role: assignableRoleSchema }),
  'room:transferHost': z.object({ userId: z.string().min(1) }),
  'playback:play': z.undefined(),
  'playback:pause': z.undefined(),
  'playback:seek': z.object({ positionMs: z.number().int().nonnegative() }),
  'playback:skip': z.undefined(),
  'playback:voteSkip': z.undefined(),
  'playback:reportUnavailable': z.object({ queueItemId: z.string().min(1) }),
  'queue:add': z.object({ url: z.string().trim().min(1).max(MAX_QUEUE_URL_LENGTH) }),
  /** Exactly one source: a playlist (own, or public) or a list of video ids (liked songs, history). */
  'queue:addMany': z
    .object({
      playlistId: z.uuid().optional(),
      videoIds: z.array(videoIdSchema).min(1).max(MAX_BATCH_VIDEOS).optional(),
    })
    .refine((p) => (p.playlistId === undefined) !== (p.videoIds === undefined), {
      message: 'Send either playlistId or videoIds',
    }),
  'queue:remove': z.object({ queueItemId: z.string().min(1) }),
  'queue:reorder': z.object({
    queueItemId: z.string().min(1),
    /** Index in the queue as the sender sees it. */
    toIndex: z.number().int().nonnegative(),
  }),
  'queue:vote': z.object({
    queueItemId: z.string().min(1),
    value: voteValueSchema.or(z.literal(0)),
  }),
  /** Length is capped by `limits.chatMessageMaxLength`, which is a setting, so the service checks it. */
  'chat:send': z.object({ body: chatBodySchema }),
  'chat:react': z.object({ emoji: reactionEmojiSchema }),
} as const;

export type ClientEventPayloads = {
  [K in keyof typeof clientEventSchemas]: z.infer<(typeof clientEventSchemas)[K]>;
};

/** The snapshot itself arrives as `room:state`; the ack only reports success or why not. */
export type JoinAck = { ok: true } | { ok: false; error: SocketError };

export interface ClientToServerEvents {
  'time:ping': (payload: ClientEventPayloads['time:ping']) => void;
  'room:join': (payload: ClientEventPayloads['room:join'], ack: (res: JoinAck) => void) => void;
  'room:leave': () => void;
  'room:update': (payload: ClientEventPayloads['room:update']) => void;
  'room:setRole': (payload: ClientEventPayloads['room:setRole']) => void;
  'room:transferHost': (payload: ClientEventPayloads['room:transferHost']) => void;
  'playback:play': () => void;
  'playback:pause': () => void;
  'playback:seek': (payload: ClientEventPayloads['playback:seek']) => void;
  'playback:skip': () => void;
  'playback:voteSkip': () => void;
  'playback:reportUnavailable': (
    payload: ClientEventPayloads['playback:reportUnavailable'],
  ) => void;
  'queue:add': (payload: ClientEventPayloads['queue:add']) => void;
  'queue:addMany': (payload: ClientEventPayloads['queue:addMany']) => void;
  'queue:remove': (payload: ClientEventPayloads['queue:remove']) => void;
  'queue:reorder': (payload: ClientEventPayloads['queue:reorder']) => void;
  'queue:vote': (payload: ClientEventPayloads['queue:vote']) => void;
  'chat:send': (payload: ClientEventPayloads['chat:send']) => void;
  'chat:react': (payload: ClientEventPayloads['chat:react']) => void;
}

export interface ServerToClientEvents {
  'time:pong': (payload: { t0: number; serverTime: number }) => void;
  'room:state': (state: RoomState) => void;
  'room:members': (payload: { members: Member[] }) => void;
  'room:updated': (payload: { room: Room }) => void;
  'room:closed': (payload: { reason: 'host' | 'empty' | 'admin' }) => void;
  'playback:state': (state: PlaybackState) => void;
  'playback:skipVotes': (votes: SkipVotes) => void;
  'queue:updated': (payload: { queue: QueueItem[] }) => void;
  'queue:addManyResult': (result: AddManyResult) => void;
  'chat:message': (message: ChatMessage) => void;
  'chat:deleted': (payload: { id: string }) => void;
  'settings:updated': (payload: SettingsUpdate) => void;
  'site:announcement': (payload: { announcement: Announcement | null }) => void;
  /** Sent on the `/admin` namespace only. */
  'admin:stats': (stats: AdminStats) => void;
  'user:kicked': (payload: { reason: 'kicked' | 'banned' }) => void;
  'chat:reaction': (reaction: ChatReaction) => void;
  error: (error: SocketError) => void;
}
