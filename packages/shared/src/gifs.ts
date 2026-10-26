import { z } from 'zod';
import { chatMediaKindSchema, chatMediaSchema } from './chat.js';

export const MAX_GIF_QUERY_LENGTH = 100;
export const GIF_PAGE_SIZE = 24;
/** Pages beyond this aren't worth a provider call; nobody scrolls that far in a chat picker. */
export const MAX_GIF_PAGE = 20;

/** `GET /api/gifs/search`. An empty `q` means trending. */
export const gifSearchQuerySchema = z.object({
  kind: chatMediaKindSchema.default('gif'),
  q: z.string().trim().max(MAX_GIF_QUERY_LENGTH).default(''),
  page: z.coerce.number().int().min(1).max(MAX_GIF_PAGE).default(1),
});
export type GifSearchQuery = z.infer<typeof gifSearchQuerySchema>;

export const gifSearchResponseSchema = z.object({
  items: z.array(chatMediaSchema),
  /** The next page, or null at the end. */
  nextPage: z.number().int().positive().nullable(),
});
export type GifSearchResponse = z.infer<typeof gifSearchResponseSchema>;

export const gifErrorCodeSchema = z.enum([
  'gifs_disabled',
  'gifs_unavailable',
  'gifs_rate_limited',
  'gifs_not_found',
]);
export type GifErrorCode = z.infer<typeof gifErrorCodeSchema>;
