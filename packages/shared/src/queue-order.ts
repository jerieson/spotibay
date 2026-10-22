import type { QueueMode } from './playback.js';

/** What the ordering needs to know about a queued item. */
export interface OrderableItem {
  id: string;
  /** User id of whoever added it. */
  addedBy: string;
  /** Base order: grows with each add, rewritten by a manual reorder. */
  position: number;
  /** Sum of the votes; only `fifo` mode looks at it. */
  score: number;
}

export interface OrderOptions {
  /**
   * User whose track is playing now. In `fair` mode they just had a turn, so their items go to
   * the back of the rotation.
   */
  playingBy?: string | null;
}

/**
 * The play order of the queued items.
 *
 * - `fifo`: highest score first, ties broken by `position`.
 * - `fair`: round-robin over the users. Users take turns in the order of their first item (with
 *   the user who is playing now last), and within a user items keep their `position` order.
 *   Scores are display-only.
 */
export function orderQueue<T extends OrderableItem>(
  items: readonly T[],
  mode: QueueMode,
  { playingBy = null }: OrderOptions = {},
): T[] {
  const byPosition = [...items].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  if (mode === 'fifo') return byPosition.sort((a, b) => b.score - a.score);

  const lanes = new Map<string, T[]>();
  for (const item of byPosition) {
    const lane = lanes.get(item.addedBy);
    if (lane) lane.push(item);
    else lanes.set(item.addedBy, [item]);
  }
  const current = playingBy === null ? undefined : lanes.get(playingBy);
  if (current && lanes.size > 1) {
    lanes.delete(playingBy!);
    lanes.set(playingBy!, current);
  }
  const ordered: T[] = [];
  for (let round = 0; ordered.length < byPosition.length; round++) {
    for (const lane of lanes.values()) {
      const item = lane[round];
      if (item) ordered.push(item);
    }
  }
  return ordered;
}

/** Moves the item with `id` to `toIndex` (clamped); the list is returned unchanged if `id` is absent. */
export function moveItem<T extends { id: string }>(
  items: readonly T[],
  id: string,
  toIndex: number,
): T[] {
  const from = items.findIndex((i) => i.id === id);
  if (from === -1) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved!);
  return next;
}

/** Votes needed to skip the current track: `ceil(members × threshold)`, never less than one. */
export function skipVotesNeeded(memberCount: number, threshold: number): number {
  return Math.max(1, Math.ceil(memberCount * threshold));
}
