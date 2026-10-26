import { Router, type Response } from 'express';
import {
  resolveBodySchema,
  searchQuerySchema,
  type ResolveBody,
  type SearchErrorCode,
  type SearchQuery,
  type SuggestResponse,
} from '@spotibay/shared';
import { validateBody, validateQuery } from '../lib/validate.js';
import { logger } from '../logger.js';
import { requireUser } from '../middleware/session.js';
import { SearchError, type SearchService } from '../services/search.js';
import { YouTubeError } from '../services/youtube.js';

const statusByCode: Record<SearchErrorCode, number> = {
  search_disabled: 403,
  search_rate_limited: 429,
  search_budget_exhausted: 429,
  search_unavailable: 502,
  catalog_disabled: 403,
  catalog_unavailable: 503,
  catalog_not_found: 404,
};

/** Answers known search failures; rethrows the rest. */
function sendError(res: Response, err: unknown) {
  if (err instanceof SearchError) {
    res.status(statusByCode[err.code]).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof YouTubeError) {
    logger.error({ err }, 'youtube search failed');
    res
      .status(statusByCode.search_unavailable)
      .json({ error: 'search_unavailable', message: 'Search is unavailable right now' });
    return;
  }
  throw err;
}

export function createSearchRouter({ search }: { search: SearchService }) {
  const router = Router();

  router.get('/search', requireUser, validateQuery(searchQuerySchema), async (req, res) => {
    const { q } = res.locals.query as SearchQuery;
    try {
      res.json(await search.search(req.user!.id, q));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get(
    '/search/suggest',
    requireUser,
    validateQuery(searchQuerySchema),
    async (_req, res) => {
      const { q } = res.locals.query as SearchQuery;
      try {
        const body: SuggestResponse = { suggestions: await search.suggest(q) };
        res.json(body);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  router.post('/search/resolve', requireUser, validateBody(resolveBodySchema), async (req, res) => {
    const { catalogId } = req.body as ResolveBody;
    try {
      res.json(await search.resolve(req.user!.id, catalogId));
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
