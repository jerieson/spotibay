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
  'features.catalogSearch': bool,
  'features.gifs': bool,
  'limits.maxActiveRooms': posInt,
  'limits.maxUsersPerRoom': posInt,
  'limits.maxQueueItemsPerUser': posInt,
  'limits.maxQueueLength': posInt,
  'limits.searchesPerMinute': posInt,
  'limits.suggestionsPerMinute': posInt,
  'limits.gifSearchesPerMinute': posInt,
  'limits.videoLookupsPerUserPerDay': nonNegInt,
  'limits.maxPlaylistImportItems': posInt,
  'limits.chatMessageMaxLength': posInt.max(2000),
  'limits.chatMessagesPerMinute': posInt,
  'limits.requestsPerMinute': posInt,
  'limits.expensiveRequestsPerMinute': posInt,
  'limits.socketEventsPerSecond': posInt,
  'queue.skipVoteThreshold': z.number().gt(0).lte(1),
  'sync.driftThresholdMs': posInt,
  'sync.checkIntervalMs': posInt.min(250),
  'search.cacheTtlSec': posInt,
  'search.dailySearchCallBudget': nonNegInt,
  'catalog.cacheTtlSec': posInt,
  'gifs.cacheTtlSec': posInt,
  'gifs.contentFilter': z.enum(['off', 'low', 'medium', 'high']),
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
  'features.catalogSearch': true,
  'features.gifs': true,
  'limits.maxActiveRooms': 50,
  'limits.maxUsersPerRoom': 30,
  'limits.maxQueueItemsPerUser': 5,
  'limits.maxQueueLength': 200,
  'limits.searchesPerMinute': 5,
  'limits.suggestionsPerMinute': 60,
  'limits.gifSearchesPerMinute': 30,
  'limits.videoLookupsPerUserPerDay': 200,
  'limits.maxPlaylistImportItems': 200,
  'limits.chatMessageMaxLength': 300,
  'limits.chatMessagesPerMinute': 20,
  'limits.requestsPerMinute': 300,
  'limits.expensiveRequestsPerMinute': 10,
  'limits.socketEventsPerSecond': 30,
  'queue.skipVoteThreshold': 0.5,
  'sync.driftThresholdMs': 600,
  'sync.checkIntervalMs': 2000,
  'search.cacheTtlSec': 604800,
  'search.dailySearchCallBudget': 95,
  'catalog.cacheTtlSec': 86400,
  'gifs.cacheTtlSec': 3600,
  'gifs.contentFilter': 'medium',
  'moderation.wordFilter': [],
  'site.maintenanceMode': false,
  'site.announcement': null,
};

export const settingKeys = Object.keys(settingsSchemas) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingsSchemas, key);
}
