import { z } from 'zod';
import { trackSchema } from './playback.js';

export const MAX_SEARCH_QUERY_LENGTH = 100;

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

/** Error codes of `GET /api/search`. */
export const searchErrorCodeSchema = z.enum([
  'search_disabled',
  'search_user_limit',
  'search_budget_exhausted',
  'search_unavailable',
]);
export type SearchErrorCode = z.infer<typeof searchErrorCodeSchema>;
