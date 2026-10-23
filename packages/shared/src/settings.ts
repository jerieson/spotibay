import { z } from 'zod';

const bool = z.boolean();
const posInt = z.number().int().positive();
const nonNegInt = z.number().int().nonnegative();

export const announcementSchema = z.object({
  text: z.string().trim().min(1).max(500),
  level: z.enum(['info', 'warning', 'critical']),
});

export type Announcement = z.infer<typeof announcementSchema>;

export const settingsSchemas = {
  'features.chat': bool,
  'features.reactions': bool,
  'features.guestRoomCreation': bool,
  'features.publicRooms': bool,
  'features.playlistImport': bool,
  'features.search': bool,
  'limits.maxActiveRooms': posInt,
  'limits.maxUsersPerRoom': posInt,
  'limits.maxQueueItemsPerUser': posInt,
  'limits.maxQueueLength': posInt,
  'limits.searchesPerUserPerDay': nonNegInt,
  'limits.maxTrackDurationSec': posInt,
  'limits.maxPlaylistImportItems': posInt,
  'limits.chatMessageMaxLength': posInt.max(2000),
  'limits.chatMessagesPerMinute': posInt,
  'queue.skipVoteThreshold': z.number().gt(0).lte(1),
  'sync.driftThresholdMs': posInt,
  'sync.checkIntervalMs': posInt.min(250),
  'search.cacheTtlSec': posInt,
  'search.dailySearchCallBudget': nonNegInt,
  'moderation.wordFilter': z.array(z.string().trim().min(1).max(64)).max(1000),
  'site.maintenanceMode': bool,
  'site.announcement': announcementSchema.nullable(),
} as const;

export type SettingKey = keyof typeof settingsSchemas;
export type SettingsValues = { [K in SettingKey]: z.infer<(typeof settingsSchemas)[K]> };

export const settingsDefaults: SettingsValues = {
  'features.chat': true,
  'features.reactions': true,
  'features.guestRoomCreation': true,
  'features.publicRooms': true,
  'features.playlistImport': true,
  'features.search': true,
  'limits.maxActiveRooms': 50,
  'limits.maxUsersPerRoom': 30,
  'limits.maxQueueItemsPerUser': 5,
  'limits.maxQueueLength': 200,
  'limits.searchesPerUserPerDay': 10,
  'limits.maxTrackDurationSec': 900,
  'limits.maxPlaylistImportItems': 200,
  'limits.chatMessageMaxLength': 300,
  'limits.chatMessagesPerMinute': 20,
  'queue.skipVoteThreshold': 0.5,
  'sync.driftThresholdMs': 600,
  'sync.checkIntervalMs': 2000,
  'search.cacheTtlSec': 604800,
  'search.dailySearchCallBudget': 95,
  'moderation.wordFilter': [],
  'site.maintenanceMode': false,
  'site.announcement': null,
};

export const settingKeys = Object.keys(settingsSchemas) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingsSchemas, key);
}
