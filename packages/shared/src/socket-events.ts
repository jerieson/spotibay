import { z } from 'zod';
import { MAX_QUEUE_URL_LENGTH, type PlaybackState, type QueueItem } from './playback.js';
import {
  assignableRoleSchema,
  roomCodeSchema,
  roomNameSchema,
  roomPasswordSchema,
  roomVisibilitySchema,
  type Member,
  type Room,
  type RoomState,
} from './rooms.js';

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
  'youtube_unavailable',
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
  'room:join': z.object({ code: roomCodeSchema, password: roomPasswordSchema.optional() }),
  'room:leave': z.undefined(),
  'room:update': z
    .object({
      name: roomNameSchema.optional(),
      visibility: roomVisibilitySchema.optional(),
      password: roomPasswordSchema.nullable().optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to update'),
  'room:setRole': z.object({ userId: z.string().min(1), role: assignableRoleSchema }),
  'room:transferHost': z.object({ userId: z.string().min(1) }),
  'playback:play': z.undefined(),
  'playback:pause': z.undefined(),
  'playback:seek': z.object({ positionMs: z.number().int().nonnegative() }),
  'playback:skip': z.undefined(),
  'playback:reportUnavailable': z.object({ queueItemId: z.string().min(1) }),
  'queue:add': z.object({ url: z.string().trim().min(1).max(MAX_QUEUE_URL_LENGTH) }),
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
  'playback:reportUnavailable': (
    payload: ClientEventPayloads['playback:reportUnavailable'],
  ) => void;
  'queue:add': (payload: ClientEventPayloads['queue:add']) => void;
}

export interface ServerToClientEvents {
  'time:pong': (payload: { t0: number; serverTime: number }) => void;
  'room:state': (state: RoomState) => void;
  'room:members': (payload: { members: Member[] }) => void;
  'room:updated': (payload: { room: Room }) => void;
  'room:closed': (payload: { reason: 'host' | 'empty' | 'admin' }) => void;
  'playback:state': (state: PlaybackState) => void;
  'queue:updated': (payload: { queue: QueueItem[] }) => void;
  error: (error: SocketError) => void;
}
