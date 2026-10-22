import { z } from 'zod';
import { avatarSchema } from './identity.js';
import { playbackStateSchema, queueItemSchema, syncConfigSchema } from './playback.js';

/** No 0/O/1/I so codes survive being read aloud. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const ROOM_NAME_MAX = 40;
export const ROOM_PASSWORD_MIN = 4;
export const ROOM_PASSWORD_MAX = 64;
/** The host is replaced if they have been gone this long. */
export const HOST_GRACE_MS = 60_000;
/** A room nobody is in is closed after this long. */
export const EMPTY_ROOM_TTL_MS = 30 * 60_000;

export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(ROOM_CODE_LENGTH, `Room codes are ${ROOM_CODE_LENGTH} characters`)
  .refine((code) => [...code].every((c) => ROOM_CODE_ALPHABET.includes(c)), 'Invalid room code');

export const roomNameSchema = z.string().trim().min(1).max(ROOM_NAME_MAX);
export const roomPasswordSchema = z.string().min(ROOM_PASSWORD_MIN).max(ROOM_PASSWORD_MAX);
export const roomVisibilitySchema = z.enum(['public', 'private']);
export const roomRoleSchema = z.enum(['host', 'dj', 'listener']);
/** Roles the host can hand out; `host` only changes through a transfer. */
export const assignableRoleSchema = z.enum(['dj', 'listener']);

export type RoomVisibility = z.infer<typeof roomVisibilitySchema>;
export type RoomRole = z.infer<typeof roomRoleSchema>;

export const createRoomBodySchema = z
  .object({
    name: roomNameSchema,
    visibility: roomVisibilitySchema.default('public'),
    password: roomPasswordSchema.optional(),
  })
  .refine((b) => b.visibility === 'private' || b.password === undefined, {
    message: 'Only private rooms can have a password',
    path: ['password'],
  });
export type CreateRoomBody = z.infer<typeof createRoomBodySchema>;

export const updateRoomBodySchema = z
  .object({
    name: roomNameSchema.optional(),
    visibility: roomVisibilitySchema.optional(),
    /** `null` removes the password. */
    password: roomPasswordSchema.nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to update');
export type UpdateRoomBody = z.infer<typeof updateRoomBodySchema>;

export const nowPlayingSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  channelTitle: z.string(),
  thumbnailUrl: z.string(),
});
export type NowPlaying = z.infer<typeof nowPlayingSchema>;

export const roomSchema = z.object({
  code: z.string(),
  name: z.string(),
  visibility: roomVisibilitySchema,
  hasPassword: z.boolean(),
  hostId: z.string(),
  queueMode: z.enum(['fifo', 'fair']),
  createdAt: z.string(),
});
export type Room = z.infer<typeof roomSchema>;

export const roomSummarySchema = roomSchema.extend({
  memberCount: z.number().int().nonnegative(),
  nowPlaying: nowPlayingSchema.nullable(),
});
export type RoomSummary = z.infer<typeof roomSummarySchema>;

export const roomResponseSchema = z.object({ room: roomSummarySchema });
export const roomListResponseSchema = z.object({ rooms: z.array(roomSummarySchema) });
export type RoomResponse = z.infer<typeof roomResponseSchema>;
export type RoomListResponse = z.infer<typeof roomListResponseSchema>;

export const memberSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  avatar: avatarSchema,
  role: roomRoleSchema,
  /** Epoch ms of the user's first live socket in the room; orders "longest present". */
  joinedAt: z.number(),
});
export type Member = z.infer<typeof memberSchema>;

export const roomStateSchema = z.object({
  room: roomSchema,
  members: z.array(memberSchema),
  you: z.object({ userId: z.string(), role: roomRoleSchema }),
  playback: playbackStateSchema,
  /** Upcoming items; the one playing now is `playback.item`. */
  queue: z.array(queueItemSchema),
  sync: syncConfigSchema,
});
export type RoomState = z.infer<typeof roomStateSchema>;
