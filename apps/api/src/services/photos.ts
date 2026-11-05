import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Avatar, ChatMedia, ChatPhotoUploadResponse } from '@spotibay/shared';
import type { Db } from '../db/client.js';
import { avatarPhotos, chatPhotos, rooms, users } from '../db/schema.js';
import { avatarPhoto, chatPhoto, ImageError } from '../lib/images.js';
import { hit } from '../lib/rate-limit.js';
import { logger } from '../logger.js';
import type { RoomService } from './rooms.js';
import type { SettingsService } from './settings.js';

/** A chat photo lives at most this long, even while its room stays open. */
export const CHAT_PHOTO_TTL_MS = 24 * 60 * 60 * 1000;
/** An upload that never got sent with a message is dropped after this long. */
const UNSENT_TTL_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export type PhotoErrorCode = 'photos_disabled' | 'invalid_image' | 'rate_limited' | 'not_found';

export class PhotoError extends Error {
  constructor(
    readonly code: PhotoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PhotoError';
  }
}

export interface PhotoServiceDeps {
  db: Db;
  redis: Redis;
  settings: Pick<SettingsService, 'get'>;
  now?: () => Date;
}

/** The URL a chat photo is served at. */
export const chatPhotoUrl = (id: string) => `/api/photos/${id}`;

/**
 * Photos posted in chat: re-encoded on upload (see `lib/images.ts`), kept in Postgres, and
 * deleted with their room, after a day, or by a moderator.
 */
export function createPhotoService({
  db,
  redis,
  settings,
  now = () => new Date(),
}: PhotoServiceDeps) {
  /** Takes an upload for `roomId` from `userId`; the caller has checked they are in the room. */
  async function upload(
    roomId: string,
    userId: string,
    input: Buffer,
  ): Promise<ChatPhotoUploadResponse> {
    if (!settings.get('features.chatPhotos')) {
      throw new PhotoError('photos_disabled', 'Photos in chat are turned off');
    }
    const allowed = await hit(
      redis,
      `ratelimit:photos:${userId}`,
      settings.get('limits.chatPhotosPerMinute'),
      60,
    );
    if (!allowed) throw new PhotoError('rate_limited', "You're posting photos too fast");
    let photo;
    try {
      photo = await chatPhoto(input);
    } catch (err) {
      if (err instanceof ImageError) throw new PhotoError('invalid_image', err.message);
      throw err;
    }
    const [row] = await db
      .insert(chatPhotos)
      .values({
        roomId,
        userId,
        width: photo.width,
        height: photo.height,
        size: photo.bytes.length,
        bytes: photo.bytes,
      })
      .returning({ id: chatPhotos.id });
    return { id: row!.id, width: photo.width, height: photo.height };
  }

  /** The photo's WebP bytes; `null` once it has been deleted or has expired. */
  async function find(id: string): Promise<Buffer | null> {
    const [row] = await db
      .select({ bytes: chatPhotos.bytes, createdAt: chatPhotos.createdAt })
      .from(chatPhotos)
      .where(eq(chatPhotos.id, id));
    if (!row || row.createdAt.getTime() < now().getTime() - CHAT_PHOTO_TTL_MS) return null;
    return row.bytes;
  }

  /**
   * The media for a message: the photo must be one this person uploaded to this room and not
   * yet sent. Link it to the message with `attach` once the message exists.
   */
  async function forMessage(roomId: string, userId: string, id: string): Promise<ChatMedia> {
    if (!settings.get('features.chatPhotos')) {
      throw new PhotoError('photos_disabled', 'Photos in chat are turned off');
    }
    const [row] = await db
      .select({ width: chatPhotos.width, height: chatPhotos.height })
      .from(chatPhotos)
      .where(
        and(
          eq(chatPhotos.id, id),
          eq(chatPhotos.roomId, roomId),
          eq(chatPhotos.userId, userId),
          isNull(chatPhotos.messageId),
        ),
      );
    if (!row) throw new PhotoError('not_found', 'That photo is no longer available');
    const url = chatPhotoUrl(id);
    return { kind: 'photo', id, title: 'Photo', url, previewUrl: url, ...row };
  }

  async function attach(id: string, messageId: string): Promise<void> {
    await db.update(chatPhotos).set({ messageId }).where(eq(chatPhotos.id, id));
  }

  /** Deletes the photos of these messages. */
  async function deleteForMessages(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    await db.delete(chatPhotos).where(inArray(chatPhotos.messageId, messageIds));
  }

  async function deleteForRoom(roomId: string): Promise<void> {
    await db.delete(chatPhotos).where(eq(chatPhotos.roomId, roomId));
  }

  /** Deletes every stored photo, in one room or all of them; resolves with how many. */
  async function purge(roomId?: string): Promise<number> {
    const rows = await db
      .delete(chatPhotos)
      .where(roomId ? eq(chatPhotos.roomId, roomId) : undefined)
      .returning({ id: chatPhotos.id });
    return rows.length;
  }

  /** Messages carrying a photo still stored, in one room or every room: what a purge takes down. */
  async function photoMessages(roomId?: string): Promise<{ messageId: string; roomId: string }[]> {
    const rows = await db
      .select({ messageId: chatPhotos.messageId, roomId: chatPhotos.roomId })
      .from(chatPhotos)
      .where(
        and(isNotNull(chatPhotos.messageId), roomId ? eq(chatPhotos.roomId, roomId) : undefined),
      );
    return rows.flatMap((r) => (r.messageId ? [{ messageId: r.messageId, roomId: r.roomId }] : []));
  }

  /** Deletes photos past their day, unsent uploads, and photos of rooms that closed. */
  async function sweep(): Promise<number> {
    const at = now().getTime();
    const deleted = await db
      .delete(chatPhotos)
      .where(
        or(
          lt(chatPhotos.createdAt, new Date(at - CHAT_PHOTO_TTL_MS)),
          and(isNull(chatPhotos.messageId), lt(chatPhotos.createdAt, new Date(at - UNSENT_TTL_MS))),
          inArray(
            chatPhotos.roomId,
            db.select({ id: rooms.id }).from(rooms).where(isNotNull(rooms.closedAt)),
          ),
        ),
      )
      .returning({ id: chatPhotos.id });
    return deleted.length;
  }

  /** Bytes kept for chat photos right now, for the admin. */
  async function storedBytes(): Promise<number> {
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${chatPhotos.size}), 0)::int` })
      .from(chatPhotos);
    return row?.total ?? 0;
  }

  /**
   * Deletes a room's photos when it closes, and sweeps expired ones now and every ten minutes
   * (which also catches rooms that closed while the server was down). Returns a stop function.
   */
  function startCleanup(roomEvents: Pick<RoomService, 'onClosed'>): () => void {
    const offClosed = roomEvents.onClosed((row) => {
      deleteForRoom(row.id).catch((err: unknown) =>
        logger.warn({ err, roomId: row.id }, 'deleting closed room photos failed'),
      );
    });
    const run = () => {
      sweep()
        .then((n) => {
          if (n > 0) logger.info({ deleted: n }, 'expired chat photos deleted');
        })
        .catch((err: unknown) => logger.warn({ err }, 'chat photo sweep failed'));
    };
    run();
    const timer = setInterval(run, SWEEP_INTERVAL_MS);
    timer.unref();
    return () => {
      offClosed();
      clearInterval(timer);
    };
  }

  return {
    upload,
    startCleanup,
    find,
    forMessage,
    attach,
    deleteForMessages,
    deleteForRoom,
    purge,
    photoMessages,
    sweep,
    storedBytes,
  };
}

export type PhotoService = ReturnType<typeof createPhotoService>;

/** People may change their photo this often per hour. */
const AVATAR_UPLOADS_PER_HOUR = 10;

export interface AvatarPhotoServiceDeps {
  db: Db;
  redis: Redis;
}

/** The URL an avatar photo is served at. */
export const avatarPhotoUrl = (id: string) => `/api/avatars/${id}`;

/**
 * People's own photos as avatars: a 256 px square, one per person. Setting or clearing one also
 * updates `users.avatar.photoId`; the generated avatar stays underneath as the fallback.
 */
export function createAvatarPhotoService({ db, redis }: AvatarPhotoServiceDeps) {
  /** Stores the picture as `userId`'s photo, replacing any old one; resolves with the new avatar. */
  async function set(userId: string, input: Buffer): Promise<Avatar> {
    if (!(await hit(redis, `ratelimit:avatar:${userId}`, AVATAR_UPLOADS_PER_HOUR, 60 * 60))) {
      throw new PhotoError('rate_limited', "You've changed your photo a lot. Try again later.");
    }
    let bytes: Buffer;
    try {
      bytes = await avatarPhoto(input);
    } catch (err) {
      if (err instanceof ImageError) throw new PhotoError('invalid_image', err.message);
      throw err;
    }
    return db.transaction(async (tx) => {
      await tx.delete(avatarPhotos).where(eq(avatarPhotos.userId, userId));
      const [row] = await tx
        .insert(avatarPhotos)
        .values({ userId, bytes })
        .returning({ id: avatarPhotos.id });
      const [user] = await tx
        .update(users)
        .set({ avatar: sql`${users.avatar} || jsonb_build_object('photoId', ${row!.id}::text)` })
        .where(eq(users.id, userId))
        .returning({ avatar: users.avatar });
      if (!user) throw new PhotoError('not_found', 'Account not found');
      return user.avatar;
    });
  }

  /** Goes back to the generated avatar; resolves with it (`null` when the account is gone). */
  async function clear(userId: string): Promise<Avatar | null> {
    return db.transaction(async (tx) => {
      await tx.delete(avatarPhotos).where(eq(avatarPhotos.userId, userId));
      const [user] = await tx
        .update(users)
        .set({ avatar: sql`${users.avatar} - 'photoId'` })
        .where(eq(users.id, userId))
        .returning({ avatar: users.avatar });
      return user?.avatar ?? null;
    });
  }

  async function find(id: string): Promise<Buffer | null> {
    const [row] = await db
      .select({ bytes: avatarPhotos.bytes })
      .from(avatarPhotos)
      .where(eq(avatarPhotos.id, id));
    return row?.bytes ?? null;
  }

  return { set, clear, find };
}

export type AvatarPhotoService = ReturnType<typeof createAvatarPhotoService>;
