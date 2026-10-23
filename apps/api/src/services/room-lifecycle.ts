import { EMPTY_ROOM_TTL_MS, HOST_GRACE_MS } from '@spotibay/shared';
import type { Presence } from './presence.js';
import type { RoomService } from './rooms.js';
import { logger } from '../logger.js';

export interface RoomLifecycleOptions {
  rooms: RoomService;
  presence: Presence;
  hostGraceMs?: number;
  emptyTtlMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Timers that depend on who is in a room: hand the host role on after the host has been gone for a
 * grace period, and close rooms that stay empty. Call `reconcile` whenever membership changes.
 */
export function createRoomLifecycle({
  rooms,
  presence,
  hostGraceMs = HOST_GRACE_MS,
  emptyTtlMs = EMPTY_ROOM_TTL_MS,
  onError = (err) => logger.error({ err }, 'room service error'),
}: RoomLifecycleOptions) {
  const hostTimers = new Map<string, NodeJS.Timeout>();
  const emptyTimers = new Map<string, NodeJS.Timeout>();

  function clearTimer(timers: Map<string, NodeJS.Timeout>, roomId: string) {
    const timer = timers.get(roomId);
    if (timer) clearTimeout(timer);
    timers.delete(roomId);
  }

  function schedule(
    timers: Map<string, NodeJS.Timeout>,
    roomId: string,
    ms: number,
    fn: () => Promise<void>,
  ) {
    if (timers.has(roomId)) return;
    const timer = setTimeout(() => {
      timers.delete(roomId);
      fn().catch(onError);
    }, ms);
    timer.unref();
    timers.set(roomId, timer);
  }

  async function handOffHost(roomId: string) {
    const row = await rooms.findById(roomId);
    if (!row || row.closedAt) return;
    const members = await presence.list(roomId);
    if (members.length === 0 || members.some((m) => m.userId === row.ownerId)) return;
    // `list` is ordered by join time, so the first member has been present the longest.
    await rooms.transferHost(row, members[0]!.userId);
  }

  async function closeIfEmpty(roomId: string) {
    const row = await rooms.findById(roomId);
    if (!row || row.closedAt || (await presence.count(roomId)) > 0) return;
    await rooms.closeRow(row, 'empty');
  }

  async function reconcile(roomId: string): Promise<void> {
    const row = await rooms.findById(roomId);
    if (!row || row.closedAt) {
      forget(roomId);
      return;
    }
    const members = await presence.list(roomId);
    if (members.length === 0) {
      clearTimer(hostTimers, roomId);
      schedule(emptyTimers, roomId, emptyTtlMs, () => closeIfEmpty(roomId));
      return;
    }
    clearTimer(emptyTimers, roomId);
    if (members.some((m) => m.userId === row.ownerId)) {
      clearTimer(hostTimers, roomId);
    } else {
      schedule(hostTimers, roomId, hostGraceMs, () => handOffHost(roomId));
    }
  }

  function forget(roomId: string) {
    clearTimer(hostTimers, roomId);
    clearTimer(emptyTimers, roomId);
  }

  /** Presence does not survive a restart, so every open room starts out empty with a fresh TTL. */
  async function start(): Promise<void> {
    for (const row of await rooms.listOpen()) {
      await presence.clear(row.id);
      await reconcile(row.id);
    }
  }

  function stop() {
    for (const id of [...hostTimers.keys(), ...emptyTimers.keys()]) forget(id);
  }

  const offClosed = rooms.onClosed((row) => forget(row.id));
  // A new room starts empty, so its TTL runs from creation.
  const offCreated = rooms.onCreated((row) => {
    reconcile(row.id).catch(onError);
  });

  return {
    reconcile,
    start,
    stop: () => {
      stop();
      offClosed();
      offCreated();
    },
  };
}

export type RoomLifecycle = ReturnType<typeof createRoomLifecycle>;
