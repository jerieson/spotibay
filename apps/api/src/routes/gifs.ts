import { Router } from 'express';
import { gifSearchQuerySchema, type GifErrorCode, type GifSearchQuery } from '@spotibay/shared';
import { validateQuery } from '../lib/validate.js';
import { requireUser } from '../middleware/session.js';
import { GifError, type GifService } from '../services/gifs.js';

const statusByCode: Record<GifErrorCode, number> = {
  gifs_disabled: 403,
  gifs_unavailable: 503,
  gifs_rate_limited: 429,
  gifs_not_found: 404,
};

export function createGifsRouter({ gifs }: { gifs: GifService }) {
  const router = Router();

  router.get('/gifs/search', requireUser, validateQuery(gifSearchQuerySchema), async (req, res) => {
    const { kind, q, page } = res.locals.query as GifSearchQuery;
    try {
      res.json(await gifs.search(req.user!.id, kind, q, page));
    } catch (err) {
      if (!(err instanceof GifError)) throw err;
      res.status(statusByCode[err.code]).json({ error: err.code, message: err.message });
    }
  });

  return router;
}
