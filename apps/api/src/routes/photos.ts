import express, { Router, type Response } from 'express';
import { roomCodeSchema } from '@spotibay/shared';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES } from '../lib/images.js';
import { requireUser } from '../middleware/session.js';
import {
  PhotoError,
  type AvatarPhotoService,
  type PhotoErrorCode,
  type PhotoService,
} from '../services/photos.js';
import { toPublicUser } from './session.js';
import type { Presence } from '../services/presence.js';
import type { RoomService } from '../services/rooms.js';

const statusByCode: Record<PhotoErrorCode, number> = {
  photos_disabled: 403,
  invalid_image: 422,
  rate_limited: 429,
  not_found: 404,
};

const idSchema = z.uuid();

/** Headers for a stored picture: never sniffed or run as anything but an image. */
export function sendImage(res: Response, bytes: Buffer, cacheControl: string) {
  res
    .set({
      'Content-Type': 'image/webp',
      'Content-Length': String(bytes.length),
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Content-Disposition': 'inline',
    })
    .end(bytes);
}

export interface PhotosRouterDeps {
  photos: PhotoService;
  /** Mounts `PUT`/`DELETE /me/avatar-photo` and `GET /avatars/:id` when provided. */
  avatars?: AvatarPhotoService;
  rooms: Pick<RoomService, 'findByCode'>;
  presence: Pick<Presence, 'get'>;
}

/** `POST /rooms/:code/photos` (raw image body) and `GET /photos/:id`; avatar photos too. */
export function createPhotosRouter({ photos, avatars, rooms, presence }: PhotosRouterDeps) {
  const router = Router();

  if (avatars) {
    router.put(
      '/me/avatar-photo',
      requireUser,
      express.raw({ type: 'image/*', limit: MAX_UPLOAD_BYTES }),
      async (req, res) => {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          res.status(415).json({ error: 'invalid_image', message: 'Send the picture as the body' });
          return;
        }
        try {
          const avatar = await avatars.set(req.user!.id, req.body);
          res.json({ user: toPublicUser({ ...req.user!, avatar }) });
        } catch (err) {
          if (!(err instanceof PhotoError)) throw err;
          res.status(statusByCode[err.code]).json({ error: err.code, message: err.message });
        }
      },
    );

    router.delete('/me/avatar-photo', requireUser, async (req, res) => {
      const avatar = await avatars.clear(req.user!.id);
      res.json({ user: toPublicUser({ ...req.user!, avatar: avatar ?? req.user!.avatar }) });
    });

    router.get('/avatars/:id', requireUser, async (req, res) => {
      const id = idSchema.safeParse(req.params.id);
      const bytes = id.success ? await avatars.find(id.data) : null;
      if (!bytes) {
        res.status(404).json({ error: 'not_found', message: 'No such photo' });
        return;
      }
      // A new photo gets a new id, so this URL never changes what it shows.
      sendImage(res, bytes, 'private, max-age=31536000, immutable');
    });
  }

  router.post(
    '/rooms/:code/photos',
    requireUser,
    express.raw({ type: 'image/*', limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      const code = roomCodeSchema.safeParse(req.params.code);
      const room = code.success ? await rooms.findByCode(code.data) : null;
      if (!room || room.closedAt) {
        res.status(404).json({ error: 'room_not_found', message: 'Room not found' });
        return;
      }
      if (!(await presence.get(room.id, req.user!.id))) {
        res.status(403).json({ error: 'not_in_room', message: 'Join the room first' });
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(415).json({ error: 'invalid_image', message: 'Send the picture as the body' });
        return;
      }
      try {
        res.status(201).json(await photos.upload(room.id, req.user!.id, req.body));
      } catch (err) {
        if (!(err instanceof PhotoError)) throw err;
        res.status(statusByCode[err.code]).json({ error: err.code, message: err.message });
      }
    },
  );

  router.get('/photos/:id', requireUser, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const bytes = id.success ? await photos.find(id.data) : null;
    if (!bytes) {
      res.status(404).json({ error: 'not_found', message: 'That photo is no longer available' });
      return;
    }
    sendImage(res, bytes, 'private, max-age=86400');
  });

  return router;
}
