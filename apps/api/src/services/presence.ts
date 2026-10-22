import type { Redis } from 'ioredis';
import { memberSchema, type Avatar, type Member, type RoomRole } from '@spotibay/shared';
import { z } from 'zod';
import { createKeyedLock } from '../lib/keyed-lock.js';

const entrySchema = z.object({
  name: z.string(),
  avatar: memberSchema.shape.avatar,
  role: memberSchema.shape.role,
  socketCount: z.number().int().positive(),
  joinedAt: z.number(),
});
type Entry = z.infer<typeof entrySchema>;

export const membersKey = (roomId: string) => `room:${roomId}:members`;

export interface PresenceUser {
  id: string;
  displayName: string;
  avatar: Avatar;
}

export type JoinResult =
  { ok: true; isNew: boolean; role: RoomRole } | { ok: false; reason: 'full' };

/** Who is in which room, backed by the `room:{id}:members` Redis hash. Tabs of one user count once. */
export function createPresence(redis: Redis, now: () => number = Date.now) {
  const withLock = createKeyedLock();

  function parse(raw: string): Entry | null {
    try {
      const result = entrySchema.safeParse(JSON.parse(raw));
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  function toMember(userId: string, entry: Entry): Member {
    return {
      userId,
      displayName: entry.name,
      avatar: entry.avatar,
      role: entry.role,
      joinedAt: entry.joinedAt,
    };
  }

  async function list(roomId: string): Promise<Member[]> {
    const all = await redis.hgetall(membersKey(roomId));
    const members: Member[] = [];
    for (const [userId, raw] of Object.entries(all)) {
      const entry = parse(raw);
      if (entry) members.push(toMember(userId, entry));
    }
    return members.sort((a, b) => a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId));
  }

  async function get(roomId: string, userId: string): Promise<Member | null> {
    const raw = await redis.hget(membersKey(roomId), userId);
    const entry = raw ? parse(raw) : null;
    return entry ? toMember(userId, entry) : null;
  }

  /** `role` only applies to a user's first socket; later tabs keep the role they have. */
  function join(
    roomId: string,
    user: PresenceUser,
    role: RoomRole,
    maxMembers: number,
  ): Promise<JoinResult> {
    return withLock(roomId, async () => {
      const key = membersKey(roomId);
      const raw = await redis.hget(key, user.id);
      const existing = raw ? parse(raw) : null;
      if (existing) {
        const next: Entry = { ...existing, socketCount: existing.socketCount + 1 };
        await redis.hset(key, user.id, JSON.stringify(next));
        return { ok: true, isNew: false, role: existing.role };
      }
      if ((await redis.hlen(key)) >= maxMembers) return { ok: false, reason: 'full' };
      const entry: Entry = {
        name: user.displayName,
        avatar: user.avatar,
        role,
        socketCount: 1,
        joinedAt: now(),
      };
      await redis.hset(key, user.id, JSON.stringify(entry));
      return { ok: true, isNew: true, role };
    });
  }

  /** Drops one socket; resolves `removed: true` once the user's last socket is gone. */
  function leave(roomId: string, userId: string): Promise<{ removed: boolean }> {
    return withLock(roomId, async () => {
      const key = membersKey(roomId);
      const raw = await redis.hget(key, userId);
      const entry = raw ? parse(raw) : null;
      if (!entry) {
        if (raw) await redis.hdel(key, userId);
        return { removed: false };
      }
      if (entry.socketCount > 1) {
        await redis.hset(
          key,
          userId,
          JSON.stringify({ ...entry, socketCount: entry.socketCount - 1 }),
        );
        return { removed: false };
      }
      await redis.hdel(key, userId);
      return { removed: true };
    });
  }

  function setRole(roomId: string, userId: string, role: RoomRole): Promise<boolean> {
    return withLock(roomId, async () => {
      const key = membersKey(roomId);
      const raw = await redis.hget(key, userId);
      const entry = raw ? parse(raw) : null;
      if (!entry) return false;
      await redis.hset(key, userId, JSON.stringify({ ...entry, role }));
      return true;
    });
  }

  const count = (roomId: string): Promise<number> => redis.hlen(membersKey(roomId));

  async function counts(roomIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (roomIds.length === 0) return result;
    const pipeline = redis.pipeline();
    for (const id of roomIds) pipeline.hlen(membersKey(id));
    const replies = (await pipeline.exec()) ?? [];
    roomIds.forEach((id, i) => {
      const value = replies[i]?.[1];
      result.set(id, typeof value === 'number' ? value : 0);
    });
    return result;
  }

  const clear = async (roomId: string): Promise<void> => {
    await redis.del(membersKey(roomId));
  };

  return { join, leave, list, get, setRole, count, counts, clear };
}

export type Presence = ReturnType<typeof createPresence>;
