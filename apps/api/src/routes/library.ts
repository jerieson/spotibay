import { Router, type ErrorRequestHandler } from 'express';
import {
  addPlaylistItemsBodySchema,
  createPlaylistBodySchema,
  importPlaylistBodySchema,
  listenHistoryQuerySchema,
  reorderPlaylistItemBodySchema,
  roomCodeSchema,
  saveHistoryBodySchema,
  updatePlaylistBodySchema,
  videoIdSchema,
  type LikesResponse,
  type ListenHistoryQuery,
  type ListenHistoryResponse,
  type PlaylistAddResponse,
  type PlaylistErrorCode,
  type PlaylistListResponse,
  type PlaylistResponse,
  type SharedPlaylistResponse,
} from '@spotibay/shared';
import { z } from 'zod';
import { validateBody, validateQuery } from '../lib/validate.js';
import { requireUser } from '../middleware/session.js';
import type { LibraryService } from '../services/library.js';
import { PlaylistError, type PlaylistService } from '../services/playlists.js';
import type { PlaybackService } from '../services/playback.js';
import type { Presence } from '../services/presence.js';
import type { RoomService } from '../services/rooms.js';

const statusByCode: Record<PlaylistErrorCode, number> = {
  playlist_not_found: 404,
  forbidden: 403,
  too_many_playlists: 409,
  playlist_full: 409,
  import_disabled: 403,
  invalid_playlist_url: 400,
  import_not_found: 404,
  youtube_unavailable: 503,
  rate_limited: 429,
  nothing_to_import: 422,
  room_not_found: 404,
  room_closed: 410,
  invalid_request: 400,
};

export interface LibraryRouterDeps {
  playlists: PlaylistService;
  library: LibraryService;
  /** With all three, "save room history as playlist" is available. */
  rooms?: RoomService;
  presence?: Presence;
  playback?: Pick<PlaybackService, 'history'>;
}

const idSchema = z.uuid();
const slugSchema = z.string().regex(/^[A-Za-z0-9_-]{6,32}$/);

export function createLibraryRouter({
  playlists,
  library,
  rooms,
  presence,
  playback,
}: LibraryRouterDeps) {
  const router = Router();
  router.use(requireUser);

  /** Malformed ids can't exist, so they are a plain 404. */
  const notFound = (res: import('express').Response) =>
    res.status(404).json({ error: 'playlist_not_found', message: 'Playlist not found' });
  router.param('id', (req, res, next, raw: string) => {
    if (!idSchema.safeParse(raw).success) return notFound(res);
    next();
  });
  router.param('slug', (req, res, next, raw: string) => {
    if (!slugSchema.safeParse(raw).success) return notFound(res);
    next();
  });
  router.param('videoId', (req, res, next, raw: string) => {
    if (!videoIdSchema.safeParse(raw).success) {
      res.status(400).json({ error: 'invalid_request', message: 'Invalid video id' });
      return;
    }
    next();
  });

  router.get('/playlists', async (req, res) => {
    const body: PlaylistListResponse = { playlists: await playlists.list(req.user!.id) };
    res.json(body);
  });

  router.post('/playlists', validateBody(createPlaylistBodySchema), async (req, res) => {
    const body: PlaylistResponse = {
      playlist: await playlists.create(req.user!.id, req.body.name),
    };
    res.status(201).json(body);
  });

  router.post('/playlists/import', validateBody(importPlaylistBodySchema), async (req, res) => {
    const body: PlaylistAddResponse = await playlists.importFromYouTube(
      req.user!.id,
      req.body.url,
      req.body.name,
    );
    res.status(201).json(body);
  });

  router.get('/playlists/shared/:slug', async (req, res) => {
    const body: SharedPlaylistResponse = {
      playlist: await playlists.getShared(req.user!.id, req.params.slug!),
    };
    res.json(body);
  });

  router.post('/playlists/shared/:slug/copy', async (req, res) => {
    const body: PlaylistResponse = {
      playlist: await playlists.copyShared(req.user!.id, req.params.slug!),
    };
    res.status(201).json(body);
  });

  router.get('/playlists/:id', async (req, res) => {
    const body: PlaylistResponse = {
      playlist: await playlists.get(req.user!.id, req.params.id!),
    };
    res.json(body);
  });

  router.patch('/playlists/:id', validateBody(updatePlaylistBodySchema), async (req, res) => {
    const body: PlaylistResponse = {
      playlist: await playlists.update(req.user!.id, req.params.id!, req.body),
    };
    res.json(body);
  });

  router.delete('/playlists/:id', async (req, res) => {
    await playlists.remove(req.user!.id, req.params.id!);
    res.status(204).end();
  });

  router.post(
    '/playlists/:id/items',
    validateBody(addPlaylistItemsBodySchema),
    async (req, res) => {
      const body: PlaylistAddResponse = await playlists.addVideos(
        req.user!.id,
        req.params.id!,
        req.body.videoIds,
      );
      res.status(201).json(body);
    },
  );

  router.delete('/playlists/:id/items/:itemId', async (req, res) => {
    if (!idSchema.safeParse(req.params.itemId).success) return notFound(res);
    const body: PlaylistResponse = {
      playlist: await playlists.removeItem(req.user!.id, req.params.id!, req.params.itemId!),
    };
    res.json(body);
  });

  router.patch(
    '/playlists/:id/items/:itemId',
    validateBody(reorderPlaylistItemBodySchema),
    async (req, res) => {
      if (!idSchema.safeParse(req.params.itemId).success) return notFound(res);
      const body: PlaylistResponse = {
        playlist: await playlists.reorderItem(
          req.user!.id,
          req.params.id!,
          req.params.itemId!,
          req.body.toIndex,
        ),
      };
      res.json(body);
    },
  );

  /** Saves what has played in the room as a new playlist. Only people in the room can. */
  if (rooms && presence && playback) {
    router.post(
      '/rooms/:code/history/playlist',
      validateBody(saveHistoryBodySchema),
      async (req, res) => {
        const code = roomCodeSchema.safeParse(req.params.code);
        const row = code.success ? await rooms.findByCode(code.data) : null;
        if (!row) throw new PlaylistError('room_not_found', 'Room not found');
        if (row.closedAt) throw new PlaylistError('room_closed', 'This room has been closed');
        if (!(await presence.get(row.id, req.user!.id))) {
          throw new PlaylistError('forbidden', 'Join the room to save its history');
        }
        const history = await playback.history(row.id);
        const body: PlaylistAddResponse = await playlists.createFromVideos(
          req.user!.id,
          req.body.name ?? `${row.name} history`.slice(0, 60),
          // History is newest first; a playlist should play in the order it was heard.
          history.map((h) => h.track.videoId).reverse(),
        );
        res.status(201).json(body);
      },
    );
  }

  router.get('/likes', async (req, res) => {
    const body: LikesResponse = { tracks: await library.listLikes(req.user!.id) };
    res.json(body);
  });

  router.put('/likes/:videoId', async (req, res) => {
    if (!(await library.like(req.user!.id, req.params.videoId!))) {
      res.status(404).json({ error: 'track_not_found', message: 'Track not found' });
      return;
    }
    res.status(204).end();
  });

  router.delete('/likes/:videoId', async (req, res) => {
    await library.unlike(req.user!.id, req.params.videoId!);
    res.status(204).end();
  });

  router.get('/me/history', validateQuery(listenHistoryQuerySchema), async (req, res) => {
    const { before } = res.locals.query as ListenHistoryQuery;
    const body: ListenHistoryResponse = await library.history(req.user!.id, before);
    res.json(body);
  });

  router.use(((err, _req, res, next) => {
    if (err instanceof PlaylistError) {
      res.status(statusByCode[err.code]).json({ error: err.code, message: err.message });
      return;
    }
    next(err);
  }) satisfies ErrorRequestHandler);

  return router;
}
