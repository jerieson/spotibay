import { Router } from 'express';
import { searchQuerySchema, type SearchErrorCode, type SearchQuery } from '@spotibay/shared';
import { validateQuery } from '../lib/validate.js';
import { requireUser } from '../middleware/session.js';
import { SearchError, type SearchService } from '../services/search.js';
import { YouTubeError } from '../services/youtube.js';

const statusByCode: Record<SearchErrorCode, number> = {
  search_disabled: 403,
  search_user_limit: 429,
  search_budget_exhausted: 429,
  search_unavailable: 502,
};

export function createSearchRouter({ search }: { search: SearchService }) {
  const router = Router();

  router.get('/search', requireUser, validateQuery(searchQuerySchema), async (req, res) => {
    const { q } = res.locals.query as SearchQuery;
    try {
      res.json(await search.search(req.user!.id, q));
    } catch (err) {
      if (err instanceof SearchError) {
        res.status(statusByCode[err.code]).json({ error: err.code, message: err.message });
        return;
      }
      if (err instanceof YouTubeError) {
        console.error(err);
        res
          .status(statusByCode.search_unavailable)
          .json({ error: 'search_unavailable', message: 'Search is unavailable right now' });
        return;
      }
      throw err;
    }
  });

  return router;
}
