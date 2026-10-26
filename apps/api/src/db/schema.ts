import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { Avatar, ChatMedia, ChatMention } from '@spotibay/shared';

export const roomVisibility = pgEnum('room_visibility', ['public', 'private']);
export const queueMode = pgEnum('queue_mode', ['fifo', 'fair']);
export const queueItemStatus = pgEnum('queue_item_status', [
  'queued',
  'playing',
  'played',
  'skipped',
  'removed',
]);
export const banType = pgEnum('ban_type', ['user', 'ip']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  avatar: jsonb('avatar').$type<Avatar>().notNull(),
  recoveryCodeHash: text('recovery_code_hash').unique(),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  bannedUntil: timestamp('banned_until', { withTimezone: true }),
  sessionVersion: integer('session_version').notNull().default(0),
});

export const admins = pgTable('admins', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  visibility: roomVisibility('visibility').notNull().default('public'),
  passwordHash: text('password_hash'),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  queueMode: queueMode('queue_mode').notNull().default('fifo'),
  createdAt: createdAt(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const tracks = pgTable('tracks', {
  videoId: text('video_id').primaryKey(),
  title: text('title').notNull(),
  channelTitle: text('channel_title').notNull(),
  durationSec: integer('duration_sec').notNull(),
  thumbnailUrl: text('thumbnail_url').notNull(),
  embeddable: boolean('embeddable').notNull().default(true),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  /** Set once the title, channel and thumbnail come from the music catalog; YouTube refreshes keep them. */
  catalogId: text('catalog_id'),
});

/** Which video plays a catalog (Deezer) track, found once and shared by everyone. */
export const catalogMatches = pgTable('catalog_matches', {
  catalogId: text('catalog_id').primaryKey(),
  videoId: text('video_id')
    .notNull()
    .references(() => tracks.videoId),
  createdAt: createdAt(),
});

export const queueItems = pgTable(
  'queue_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id),
    videoId: text('video_id')
      .notNull()
      .references(() => tracks.videoId),
    addedBy: uuid('added_by')
      .notNull()
      .references(() => users.id),
    position: integer('position').notNull(),
    status: queueItemStatus('status').notNull().default('queued'),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [index('queue_items_room_status_position_idx').on(t.roomId, t.status, t.position)],
);

export const queueVotes = pgTable(
  'queue_votes',
  {
    queueItemId: uuid('queue_item_id')
      .notNull()
      .references(() => queueItems.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    value: smallint('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.queueItemId, t.userId] })],
);

export const playlists = pgTable('playlists', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  isPublic: boolean('is_public').notNull().default(false),
  shareSlug: text('share_slug').notNull().unique(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const playlistItems = pgTable(
  'playlist_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playlistId: uuid('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    videoId: text('video_id')
      .notNull()
      .references(() => tracks.videoId),
    position: integer('position').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('playlist_items_playlist_position_idx').on(t.playlistId, t.position)],
);

export const likes = pgTable(
  'likes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    videoId: text('video_id')
      .notNull()
      .references(() => tracks.videoId),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.videoId] })],
);

export const listenHistory = pgTable(
  'listen_history',
  {
    id: serial('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    videoId: text('video_id')
      .notNull()
      .references(() => tracks.videoId),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id),
    playedAt: timestamp('played_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('listen_history_user_played_idx').on(t.userId, t.playedAt)],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    replyToId: uuid('reply_to_id').references((): AnyPgColumn => chatMessages.id),
    /** Who was mentioned, with their names as written in the body. */
    mentions: jsonb('mentions').$type<ChatMention[]>().notNull().default([]),
    /** A GIF or sticker, as resolved by the server. */
    media: jsonb('media').$type<ChatMedia>(),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByAdminId: uuid('deleted_by_admin_id').references(() => admins.id),
  },
  (t) => [index('chat_messages_room_created_idx').on(t.roomId, t.createdAt)],
);

export const chatMessageReactions = pgTable(
  'chat_message_reactions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    emoji: text('emoji').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

export const bans = pgTable('bans', {
  id: serial('id').primaryKey(),
  type: banType('type').notNull(),
  value: text('value').notNull(),
  reason: text('reason'),
  createdByAdminId: uuid('created_by_admin_id').references(() => admins.id),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedByAdminId: uuid('updated_by_admin_id').references(() => admins.id),
});

export const adminAuditLog = pgTable('admin_audit_log', {
  id: serial('id').primaryKey(),
  adminId: uuid('admin_id').references(() => admins.id),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  details: jsonb('details')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
});

export const apiQuotaUsage = pgTable('api_quota_usage', {
  date: date('date').primaryKey(),
  units: integer('units').notNull().default(0),
  searchCalls: integer('search_calls').notNull().default(0),
});
