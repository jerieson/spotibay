import { Router } from 'express';
import {
  createRoomBodySchema,
  roomCodeSchema,
  updateRoomBodySchema,
  type RoomHistoryResponse,
  type RoomListResponse,
  type RoomResponse,
} from '@spotibay/shared';
import { validateBody } from '../lib/validate.js';
import { requireUser } from '../middleware/session.js';
import type { PlaybackService } from '../services/playback.js';
import type { Presence } from '../services/presence.js';
import { RoomError, type RoomErrorCode, type RoomService } from '../services/rooms.js';

const statusByCode: Record<RoomErrorCode, number> = {
  guest_room_creation_disabled: 403,
  public_rooms_disabled: 403,
  too_many_rooms: 429,
  room_not_found: 404,
  room_closed: 410,
  forbidden: 403,
  invalid_request: 400,
  user_not_in_room: 404,
};

export interface RoomsRouterDeps {
  rooms: RoomService;
  /** Needed for the room history route. */
  presence?: Presence;
  playback?: Pick<PlaybackService, 'history'>;
}

export function createRoomsRouter({ rooms, presence, playback }: RoomsRouterDeps) {
  const router = Router();
  router.use(requireUser);

  /** Parses `:code`; a malformed code can't exist, so it is a plain 404. */
  router.param('code', (req, res, next, raw: string) => {
    const parsed = roomCodeSchema.safeParse(raw);
    if (!parsed.success) {
      res.status(404).json({ error: 'room_not_found', message: 'Room not found' });
      return;
    }
    req.params.code = parsed.data;
    next();
  });

  router.post('/rooms', validateBody(createRoomBodySchema), async (req, res) => {
    const body: RoomResponse = { room: await rooms.create(req.user!.id, req.body) };
    res.status(201).json(body);
  });

  router.get('/rooms', async (_req, res) => {
    const body: RoomListResponse = { rooms: await rooms.listPublic() };
    res.json(body);
  });

  router.get('/rooms/:code', async (req, res) => {
    const body: RoomResponse = { room: await rooms.get(req.params.code) };
    res.json(body);
  });

  router.patch('/rooms/:code', validateBody(updateRoomBodySchema), async (req, res) => {
    const body: RoomResponse = {
      room: await rooms.update(req.params.code!, req.user!.id, req.body),
    };
    res.json(body);
  });

  /** Tracks played in the room, newest first. Only people in the room can see them. */
  if (presence && playback) {
    router.get('/rooms/:code/history', async (req, res) => {
      const row = await rooms.findByCode(req.params.code);
      if (!row) throw new RoomError('room_not_found', 'Room not found');
      if (row.closedAt) throw new RoomError('room_closed', 'This room has been closed');
      if (!(await presence.get(row.id, req.user!.id))) {
        throw new RoomError('forbidden', 'Join the room to see its history');
      }
      const body: RoomHistoryResponse = { history: await playback.history(row.id) };
      res.json(body);
    });
  }

  router.post('/rooms/:code/close', async (req, res) => {
    await rooms.close(req.params.code, req.user!.id, 'host');
    res.status(204).end();
  });

  router.use(((err, _req, res, next) => {
    if (err instanceof RoomError) {
      res.status(statusByCode[err.code]).json({ error: err.code, message: err.message });
      return;
    }
    next(err);
  }) satisfies import('express').ErrorRequestHandler);

  return router;
}
