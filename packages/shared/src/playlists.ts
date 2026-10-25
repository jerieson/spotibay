import { z } from 'zod';
import { VIDEO_ID_PATTERN, MAX_QUEUE_URL_LENGTH, trackSchema } from './playback.js';

export const MAX_PLAYLISTS_PER_USER = 50;
export const MAX_PLAYLIST_ITEMS = 500;
export const MAX_PLAYLIST_NAME_LENGTH = 60;
/** Videos accepted by one add-items request or one `queue:addMany`. */
export const MAX_BATCH_VIDEOS = 50;
export const HISTORY_PAGE_SIZE = 30;

export const playlistNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(MAX_PLAYLIST_NAME_LENGTH);
export const videoIdSchema = z.string().regex(VIDEO_ID_PATTERN, 'Invalid video id');
export const videoIdsSchema = z.array(videoIdSchema).min(1).max(MAX_BATCH_VIDEOS);

export const playlistSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  isPublic: z.boolean(),
  shareSlug: z.string(),
  itemCount: z.number().int().nonnegative(),
  /** Cover for list views: the first track's thumbnail. */
  thumbnailUrl: z.string().nullable(),
  updatedAt: z.string(),
});
export type PlaylistSummary = z.infer<typeof playlistSummarySchema>;

export const playlistItemSchema = z.object({
  id: z.string(),
  track: trackSchema,
});
export type PlaylistItem = z.infer<typeof playlistItemSchema>;

export const playlistDetailSchema = playlistSummarySchema.extend({
  items: z.array(playlistItemSchema),
});
export type PlaylistDetail = z.infer<typeof playlistDetailSchema>;

/** What anyone with a public playlist's link sees. */
export const sharedPlaylistSchema = playlistDetailSchema.extend({
  owner: z.object({ displayName: z.string() }),
  /** Whether the viewer owns it, so the page can offer editing instead of copying. */
  isOwner: z.boolean(),
});
export type SharedPlaylist = z.infer<typeof sharedPlaylistSchema>;

export const createPlaylistBodySchema = z.object({ name: playlistNameSchema });
export type CreatePlaylistBody = z.infer<typeof createPlaylistBodySchema>;

export const updatePlaylistBodySchema = z
  .object({ name: playlistNameSchema, isPublic: z.boolean() })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');
export type UpdatePlaylistBody = z.infer<typeof updatePlaylistBodySchema>;

export const addPlaylistItemsBodySchema = z.object({ videoIds: videoIdsSchema });
export type AddPlaylistItemsBody = z.infer<typeof addPlaylistItemsBodySchema>;

export const reorderPlaylistItemBodySchema = z.object({
  toIndex: z.number().int().nonnegative(),
});
export type ReorderPlaylistItemBody = z.infer<typeof reorderPlaylistItemBodySchema>;

export const importPlaylistBodySchema = z.object({
  url: z.string().trim().min(1).max(MAX_QUEUE_URL_LENGTH),
  name: playlistNameSchema.optional(),
});
export type ImportPlaylistBody = z.infer<typeof importPlaylistBodySchema>;

export const saveHistoryBodySchema = z.object({ name: playlistNameSchema.optional() });
export type SaveHistoryBody = z.infer<typeof saveHistoryBodySchema>;

export const playlistListResponseSchema = z.object({ playlists: z.array(playlistSummarySchema) });
export type PlaylistListResponse = z.infer<typeof playlistListResponseSchema>;

export const playlistResponseSchema = z.object({ playlist: playlistDetailSchema });
export type PlaylistResponse = z.infer<typeof playlistResponseSchema>;

export const sharedPlaylistResponseSchema = z.object({ playlist: sharedPlaylistSchema });
export type SharedPlaylistResponse = z.infer<typeof sharedPlaylistResponseSchema>;

/** `added` were new to the playlist; `skipped` were duplicates, unplayable or over the cap. */
export const playlistAddResponseSchema = z.object({
  playlist: playlistDetailSchema,
  added: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type PlaylistAddResponse = z.infer<typeof playlistAddResponseSchema>;

export type PlaylistErrorCode =
  | 'playlist_not_found'
  | 'forbidden'
  | 'too_many_playlists'
  | 'playlist_full'
  | 'import_disabled'
  | 'invalid_playlist_url'
  | 'import_not_found'
  | 'youtube_unavailable'
  | 'rate_limited'
  | 'nothing_to_import'
  | 'room_not_found'
  | 'room_closed'
  | 'invalid_request';

export const likesResponseSchema = z.object({ tracks: z.array(trackSchema) });
export type LikesResponse = z.infer<typeof likesResponseSchema>;

export const listenHistoryEntrySchema = z.object({
  id: z.number().int(),
  track: trackSchema,
  playedAt: z.string(),
});
export type ListenHistoryEntry = z.infer<typeof listenHistoryEntrySchema>;

export const listenHistoryQuerySchema = z.object({
  /** `id` of the last entry already shown; entries older than it are returned. */
  before: z.coerce.number().int().positive().optional(),
});
export type ListenHistoryQuery = z.infer<typeof listenHistoryQuerySchema>;

export const listenHistoryResponseSchema = z.object({
  entries: z.array(listenHistoryEntrySchema),
  nextBefore: z.number().int().nullable(),
});
export type ListenHistoryResponse = z.infer<typeof listenHistoryResponseSchema>;

/** Outcome of `queue:addMany`, sent to the requester only. */
export const addManyResultSchema = z.object({
  added: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  unplayable: z.number().int().nonnegative(),
  /** Left out because the queue or the user's share of it was full. */
  overLimit: z.number().int().nonnegative(),
});
export type AddManyResult = z.infer<typeof addManyResultSchema>;
