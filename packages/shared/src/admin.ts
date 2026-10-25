import { z } from 'zod';
import { avatarSchema } from './identity.js';
import { memberSchema, nowPlayingSchema, roomVisibilitySchema } from './rooms.js';
import { queueItemSchema, playbackStateSchema, queueModeSchema } from './playback.js';
import { announcementSchema, settingKeys, type SettingKey } from './settings.js';

export const ADMIN_COOKIE = 'spotibay_admin';
export const ADMIN_SESSION_MAX_AGE_SEC = 12 * 60 * 60;
export const ADMIN_LOGIN_LIMIT = 5;
export const ADMIN_LOGIN_WINDOW_SEC = 15 * 60;
export const QUOTA_HISTORY_DAYS = 14;
export const ADMIN_STATS_INTERVAL_MS = 3000;

/** What the admin panel shows next to each setting; the record type forces a line for new keys. */
export const settingDescriptions: Record<SettingKey, string> = {
  'features.chat': 'Let people chat in rooms.',
  'features.reactions': 'Let people send floating emoji reactions.',
  'features.guestRoomCreation': 'Let guests create rooms. Turn off to freeze room creation.',
  'features.publicRooms': 'Allow public rooms and list them on the home page.',
  'features.playlistImport': 'Allow importing YouTube playlists into the library.',
  'features.search': 'Allow YouTube search. Pasting a link still works when off.',
  'features.catalogSearch':
    'Suggest songs from the Deezer catalog while typing. Off: search goes straight to YouTube.',
  'limits.maxActiveRooms': 'Open rooms allowed at the same time.',
  'limits.maxUsersPerRoom': 'People allowed in one room.',
  'limits.maxQueueItemsPerUser': 'Tracks one person can have in a room queue at once.',
  'limits.maxQueueLength': 'Tracks allowed in one room queue.',
  'limits.searchesPerUserPerDay':
    'YouTube searches per person per day (Pacific Time). Adding a suggested song nobody has added before uses one.',
  'limits.suggestionsPerMinute': 'Song suggestion requests one address can make per minute.',
  'limits.videoLookupsPerUserPerDay':
    'YouTube lookups of videos new to the app one person can cause per day. Each covers up to 50 videos and costs 1 quota unit.',
  'limits.maxTrackDurationSec': 'Longest track that can be queued, in seconds.',
  'limits.maxPlaylistImportItems': 'Most tracks imported from one YouTube playlist.',
  'limits.chatMessageMaxLength': 'Longest chat message, in characters.',
  'limits.chatMessagesPerMinute': 'Chat messages one person can send per minute.',
  'limits.requestsPerMinute': 'API requests one address can make per minute.',
  'limits.expensiveRequestsPerMinute':
    'Account, room and playlist-import requests one address can make per minute.',
  'limits.socketEventsPerSecond': 'Realtime events one person can send per second.',
  'queue.skipVoteThreshold': 'Fraction of the room that must vote to skip a track.',
  'sync.driftThresholdMs': 'How far a player may drift before it seeks, in milliseconds.',
  'sync.checkIntervalMs': 'How often players check for drift, in milliseconds.',
  'search.cacheTtlSec': 'How long search results are cached, in seconds.',
  'search.dailySearchCallBudget':
    'YouTube search calls allowed per day. Each costs 100 quota units of the 10,000 default.',
  'catalog.cacheTtlSec': 'How long song suggestions are cached, in seconds.',
  'moderation.wordFilter': 'Words masked in chat, one per line.',
  'site.maintenanceMode': 'Show a maintenance page and refuse everyone except admins.',
  'site.announcement': 'A banner shown to everyone. Leave empty for none.',
};

/** Settings that clients receive in `settings:updated`. The rest stay server-side. */
export const publicSettingKeys = [
  'features.chat',
  'features.reactions',
  'features.guestRoomCreation',
  'features.publicRooms',
  'features.playlistImport',
  'features.search',
  'limits.chatMessageMaxLength',
  'site.maintenanceMode',
  'site.announcement',
] as const satisfies readonly SettingKey[];
export type PublicSettingKey = (typeof publicSettingKeys)[number];

export function isPublicSettingKey(key: string): key is PublicSettingKey {
  return (publicSettingKeys as readonly string[]).includes(key);
}

export const settingGroup = (key: string) => key.split('.')[0] ?? key;

export const adminLoginBodySchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type AdminLoginBody = z.infer<typeof adminLoginBodySchema>;

export const adminMeResponseSchema = z.object({ admin: z.object({ username: z.string() }) });

export const adminSettingsResponseSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
  version: z.number().int().nonnegative(),
});
export type AdminSettingsResponse = z.infer<typeof adminSettingsResponseSchema>;

export const adminSettingUpdateBodySchema = z.object({ value: z.unknown() });

export const siteResponseSchema = z.object({
  maintenance: z.boolean(),
  announcement: announcementSchema.nullable(),
});
export type SiteResponse = z.infer<typeof siteResponseSchema>;

export const adminStatsSchema = z.object({
  rooms: z.number().int().nonnegative(),
  usersOnline: z.number().int().nonnegative(),
});
export type AdminStats = z.infer<typeof adminStatsSchema>;

export const adminRoomSummarySchema = z.object({
  code: z.string(),
  name: z.string(),
  visibility: roomVisibilitySchema,
  hostId: z.string(),
  hostName: z.string().nullable(),
  queueMode: queueModeSchema,
  createdAt: z.string(),
  memberCount: z.number().int().nonnegative(),
  queueLength: z.number().int().nonnegative(),
  nowPlaying: nowPlayingSchema.nullable(),
});
export type AdminRoomSummary = z.infer<typeof adminRoomSummarySchema>;

export const adminRoomDetailSchema = adminRoomSummarySchema.extend({
  members: z.array(memberSchema),
  playback: playbackStateSchema,
  queue: z.array(queueItemSchema),
});
export type AdminRoomDetail = z.infer<typeof adminRoomDetailSchema>;

export const adminRoomListResponseSchema = z.object({ rooms: z.array(adminRoomSummarySchema) });
export const adminRoomResponseSchema = z.object({ room: adminRoomDetailSchema });

export const banTypeSchema = z.enum(['user', 'ip']);
export const MAX_BAN_REASON = 300;
/** One year; `null` means permanent. */
export const MAX_BAN_MINUTES = 60 * 24 * 365;

export const createBanBodySchema = z.object({
  type: banTypeSchema,
  value: z.string().trim().min(1).max(64),
  reason: z.string().trim().max(MAX_BAN_REASON).optional(),
  durationMinutes: z.number().int().positive().max(MAX_BAN_MINUTES).nullable().default(null),
});
export type CreateBanBody = z.infer<typeof createBanBodySchema>;

export const adminBanSchema = z.object({
  id: z.number().int(),
  type: banTypeSchema,
  value: z.string(),
  /** Display name when the ban targets a user we still know. */
  userName: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  active: z.boolean(),
});
export type AdminBan = z.infer<typeof adminBanSchema>;
export const adminBanListResponseSchema = z.object({ bans: z.array(adminBanSchema) });
export const adminBanResponseSchema = z.object({ ban: adminBanSchema });

export const adminUserSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  avatar: avatarSchema,
  createdAt: z.string(),
  lastSeenAt: z.string(),
  banned: z.boolean(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;
export const adminUserListResponseSchema = z.object({ users: z.array(adminUserSchema) });

export const adminUserDetailSchema = adminUserSchema.extend({
  rooms: z.array(z.object({ code: z.string(), name: z.string() })),
  /** Addresses of the user's live connections; the app stores no others. */
  ips: z.array(z.string()),
  bans: z.array(adminBanSchema),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;
export const adminUserResponseSchema = z.object({ user: adminUserDetailSchema });

export const kickBodySchema = z.object({ userId: z.uuid() });

export const adminChatMessageSchema = z.object({
  id: z.string(),
  roomCode: z.string(),
  roomName: z.string(),
  userId: z.string(),
  userName: z.string(),
  body: z.string(),
  createdAt: z.string(),
  deleted: z.boolean(),
});
export type AdminChatMessage = z.infer<typeof adminChatMessageSchema>;
export const adminChatListResponseSchema = z.object({ messages: z.array(adminChatMessageSchema) });

export const quotaDaySchema = z.object({
  date: z.string(),
  units: z.number().int().nonnegative(),
  searchCalls: z.number().int().nonnegative(),
});
export const adminQuotaResponseSchema = z.object({
  today: quotaDaySchema,
  searchCallBudget: z.number().int().nonnegative(),
  /** Oldest first, one entry per day, including days without usage. */
  days: z.array(quotaDaySchema),
});
export type AdminQuotaResponse = z.infer<typeof adminQuotaResponseSchema>;

export const auditEntrySchema = z.object({
  id: z.number().int(),
  adminUsername: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export const auditQuerySchema = z.object({
  action: z.string().trim().min(1).max(64).optional(),
  targetType: z.string().trim().min(1).max(32).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const auditListResponseSchema = z.object({
  entries: z.array(auditEntrySchema),
  nextBefore: z.number().int().nullable(),
});
export type AuditListResponse = z.infer<typeof auditListResponseSchema>;

export const adminUserQuerySchema = z.object({ q: z.string().trim().max(64).default('') });
export const adminChatQuerySchema = z.object({
  roomCode: z.string().trim().max(12).optional(),
  userId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const adminBanQuerySchema = z.object({
  includeExpired: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const adminSettingKeyList = settingKeys;
