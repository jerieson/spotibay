import { randomInt } from 'node:crypto';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type CreateRoomBody,
  type Room,
  type RoomSummary,
  type SettingKey,
  type SettingsValues,
  type UpdateRoomBody,
} from '@spotibay/shared';
import { createKeyedLock } from '../lib/keyed-lock.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import type { Presence } from './presence.js';

export interface RoomRow {
  id: string;
  code: string;
  name: string;
  visibility: 'public' | 'private';
  passwordHash: string | null;
  ownerId: string;
  queueMode: 'fifo' | 'fair';
  createdAt: Date;
  closedAt: Date | null;
}

export interface RoomStore {
  /** Resolves `null` when the code is already taken. */
  insert(input: {
    code: string;
    name: string;
    visibility: 'public' | 'private';
    passwordHash: string | null;
    ownerId: string;
  }): Promise<RoomRow | null>;
  findByCode(code: string): Promise<RoomRow | null>;
  findById(id: string): Promise<RoomRow | null>;
  listOpen(): Promise<RoomRow[]>;
  update(
    id: string,
    patch: Partial<Pick<RoomRow, 'name' | 'visibility' | 'passwordHash' | 'ownerId'>>,
  ): Promise<RoomRow | null>;
  /** Resolves `false` when the room was already closed. */
  close(id: string): Promise<boolean>;
}

export type RoomErrorCode =
  | 'guest_room_creation_disabled'
  | 'public_rooms_disabled'
  | 'too_many_rooms'
  | 'room_not_found'
  | 'room_closed'
  | 'forbidden'
  | 'invalid_request'
  | 'user_not_in_room';

export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

export type CloseReason = 'host' | 'empty' | 'admin';

export interface RoomServiceDeps {
  store: RoomStore;
  presence: Presence;
  settings: { get<K extends SettingKey>(key: K): SettingsValues[K] };
}

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export function toRoom(row: RoomRow): Room {
  return {
    code: row.code,
    name: row.name,
    visibility: row.visibility,
    hasPassword: row.passwordHash !== null,
    hostId: row.ownerId,
    queueMode: row.queueMode,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createRoomService({ store, presence, settings }: RoomServiceDeps) {
  const withLock = createKeyedLock();
  const createdListeners = new Set<(row: RoomRow) => void>();
  const updatedListeners = new Set<(row: RoomRow) => void>();
  const closedListeners = new Set<(row: RoomRow, reason: CloseReason) => void>();

  /** Open room by code, or the reason there isn't one. */
  async function requireOpen(code: string): Promise<RoomRow> {
    const row = await store.findByCode(code);
    if (!row) throw new RoomError('room_not_found', 'Room not found');
    if (row.closedAt) throw new RoomError('room_closed', 'This room has been closed');
    return row;
  }

  async function summarize(row: RoomRow): Promise<RoomSummary> {
    // Phase 4 fills `nowPlaying` from the room's playback state.
    return { ...toRoom(row), memberCount: await presence.count(row.id), nowPlaying: null };
  }

  async function create(ownerId: string, body: CreateRoomBody): Promise<RoomSummary> {
    if (!settings.get('features.guestRoomCreation')) {
      throw new RoomError('guest_room_creation_disabled', 'Room creation is turned off');
    }
    if (body.visibility === 'public' && !settings.get('features.publicRooms')) {
      throw new RoomError('public_rooms_disabled', 'Public rooms are turned off');
    }
    const passwordHash = body.password ? await hashPassword(body.password) : null;
    return withLock('create', async () => {
      if ((await store.listOpen()).length >= settings.get('limits.maxActiveRooms')) {
        throw new RoomError('too_many_rooms', 'Too many active rooms right now, try again later');
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const row = await store.insert({
          code: generateRoomCode(),
          name: body.name,
          visibility: body.visibility,
          passwordHash,
          ownerId,
        });
        if (row) {
          for (const listener of createdListeners) listener(row);
          return summarize(row);
        }
      }
      throw new Error('could not allocate a unique room code');
    });
  }

  async function listPublic(): Promise<RoomSummary[]> {
    if (!settings.get('features.publicRooms')) return [];
    const rows = (await store.listOpen()).filter((r) => r.visibility === 'public');
    const counts = await presence.counts(rows.map((r) => r.id));
    return rows
      .map((row) => ({ ...toRoom(row), memberCount: counts.get(row.id) ?? 0, nowPlaying: null }))
      .sort((a, b) => b.memberCount - a.memberCount || b.createdAt.localeCompare(a.createdAt));
  }

  async function get(code: string): Promise<RoomSummary> {
    return summarize(await requireOpen(code));
  }

  async function update(code: string, userId: string, body: UpdateRoomBody): Promise<RoomSummary> {
    const row = await requireOpen(code);
    if (row.ownerId !== userId) throw new RoomError('forbidden', 'Only the host can do that');
    const visibility = body.visibility ?? row.visibility;
    const patch: Parameters<RoomStore['update']>[1] = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.visibility !== undefined) patch.visibility = body.visibility;
    if (visibility === 'public') {
      if (typeof body.password === 'string') {
        throw new RoomError('invalid_request', 'Only private rooms can have a password');
      }
      patch.passwordHash = null;
    } else if (body.password !== undefined) {
      patch.passwordHash = body.password === null ? null : await hashPassword(body.password);
    }
    if (
      visibility === 'public' &&
      !settings.get('features.publicRooms') &&
      row.visibility !== 'public'
    ) {
      throw new RoomError('public_rooms_disabled', 'Public rooms are turned off');
    }
    const next = await store.update(row.id, patch);
    if (!next) throw new RoomError('room_not_found', 'Room not found');
    for (const listener of updatedListeners) listener(next);
    return summarize(next);
  }

  /** `by` is the acting user id, or `null` for a system/admin close. */
  async function close(code: string, by: string | null, reason: CloseReason): Promise<void> {
    const row = await requireOpen(code);
    if (by !== null && row.ownerId !== by) {
      throw new RoomError('forbidden', 'Only the host can do that');
    }
    await closeRow(row, reason);
  }

  async function closeRow(row: RoomRow, reason: CloseReason): Promise<void> {
    if (!(await store.close(row.id))) return;
    await presence.clear(row.id);
    for (const listener of closedListeners) listener(row, reason);
  }

  /** Makes `userId` (who must be present) the host; the previous host, if present, becomes a listener. */
  async function transferHost(row: RoomRow, userId: string): Promise<RoomRow> {
    if (!(await presence.get(row.id, userId))) {
      throw new RoomError('user_not_in_room', 'That person is not in the room');
    }
    if (row.ownerId !== userId) {
      if (await presence.get(row.id, row.ownerId)) {
        await presence.setRole(row.id, row.ownerId, 'listener');
      }
    }
    await presence.setRole(row.id, userId, 'host');
    const next = await store.update(row.id, { ownerId: userId });
    if (!next) throw new RoomError('room_not_found', 'Room not found');
    for (const listener of updatedListeners) listener(next);
    return next;
  }

  async function checkPassword(row: RoomRow, password: string | undefined): Promise<boolean> {
    if (!row.passwordHash) return true;
    return password !== undefined && verifyPassword(row.passwordHash, password);
  }

  return {
    create,
    listPublic,
    get,
    update,
    close,
    closeRow,
    transferHost,
    checkPassword,
    findByCode: store.findByCode,
    findById: store.findById,
    listOpen: store.listOpen,
    onCreated(listener: (row: RoomRow) => void) {
      createdListeners.add(listener);
      return () => createdListeners.delete(listener);
    },
    onUpdated(listener: (row: RoomRow) => void) {
      updatedListeners.add(listener);
      return () => updatedListeners.delete(listener);
    },
    onClosed(listener: (row: RoomRow, reason: CloseReason) => void) {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
  };
}

export type RoomService = ReturnType<typeof createRoomService>;
