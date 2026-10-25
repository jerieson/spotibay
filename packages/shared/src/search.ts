import { z } from 'zod';
import { trackSchema } from './playback.js';

export const MAX_SEARCH_QUERY_LENGTH = 100;
/** Suggestions are asked for once the query is at least this long. */
export const MIN_SUGGEST_QUERY_LENGTH = 2;

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Enter something to search for').max(MAX_SEARCH_QUERY_LENGTH),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchResponseSchema = z.object({
  results: z.array(trackSchema),
  /** Searches this user can still run today; cached answers don't use any. */
  remainingSearchesToday: z.number().int().nonnegative(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

/** Error codes of `GET /api/search`, `GET /api/search/suggest` and `POST /api/search/resolve`. */
export const searchErrorCodeSchema = z.enum([
  'search_disabled',
  'search_user_limit',
  'search_budget_exhausted',
  'search_unavailable',
  'catalog_disabled',
  'catalog_unavailable',
  'catalog_not_found',
]);
export type SearchErrorCode = z.infer<typeof searchErrorCodeSchema>;

/** A song from the music catalog (Deezer). It has no video until it is resolved. */
export const catalogTrackSchema = z.object({
  /** Deezer track id. */
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  artworkUrl: z.string().nullable(),
  durationSec: z.number().int().nonnegative(),
});
export type CatalogTrack = z.infer<typeof catalogTrackSchema>;

export const catalogIdSchema = z.string().regex(/^\d{1,20}$/, 'Invalid catalog id');

export const suggestResponseSchema = z.object({ suggestions: z.array(catalogTrackSchema) });
export type SuggestResponse = z.infer<typeof suggestResponseSchema>;

export const resolveBodySchema = z.object({ catalogId: catalogIdSchema });
export type ResolveBody = z.infer<typeof resolveBodySchema>;

/**
 * `matched`: the video that plays this song. `no_match`: no video was a confident match, so
 * these are the YouTube results to pick from.
 */
export const resolveResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('matched'),
    track: trackSchema,
    remainingSearchesToday: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('no_match'),
    results: z.array(trackSchema),
    remainingSearchesToday: z.number().int().nonnegative(),
  }),
]);
export type ResolveResponse = z.infer<typeof resolveResponseSchema>;
