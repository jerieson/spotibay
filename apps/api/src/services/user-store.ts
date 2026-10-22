import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bans, rooms, users } from '../db/schema.js';
import type { UserRecord, UserStore } from './identity.js';
import type { BanStore } from './bans.js';
import type { RoomRow, RoomStore } from './rooms.js';

const columns = {
  id: users.id,
  displayName: users.displayName,
  avatar: users.avatar,
  createdAt: users.createdAt,
  lastSeenAt: users.lastSeenAt,
  bannedUntil: users.bannedUntil,
};

export function createUserStore(db: Db): UserStore {
  const one = async (rows: Promise<UserRecord[]>) => (await rows)[0] ?? null;
  return {
    async create(input) {
      const [row] = await db
        .insert(users)
        .values({
          displayName: input.displayName,
          avatar: input.avatar,
          recoveryCodeHash: input.recoveryCodeHash,
        })
        .returning(columns);
      return row!;
    },
    findById: (id) => one(db.select(columns).from(users).where(eq(users.id, id)).limit(1)),
    findByRecoveryHash: (hash) =>
      one(db.select(columns).from(users).where(eq(users.recoveryCodeHash, hash)).limit(1)),
    async setRecoveryHash(id, hash) {
      await db.update(users).set({ recoveryCodeHash: hash }).where(eq(users.id, id));
    },
    updateProfile: (id, patch) =>
      one(db.update(users).set(patch).where(eq(users.id, id)).returning(columns)),
    async touch(id) {
      await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, id));
    },
  };
}

export function createBanStore(db: Db): BanStore {
  return {
    async findActiveBan({ userId, ip }) {
      const targets = [
        ...(userId ? [and(eq(bans.type, 'user'), eq(bans.value, userId))] : []),
        ...(ip ? [and(eq(bans.type, 'ip'), eq(bans.value, ip))] : []),
      ];
      if (targets.length === 0) return null;
      const [row] = await db
        .select({ reason: bans.reason, expiresAt: bans.expiresAt })
        .from(bans)
        .where(and(or(...targets), or(isNull(bans.expiresAt), gt(bans.expiresAt, new Date()))))
        .limit(1);
      return row ?? null;
    },
  };
}

export function createRoomStore(db: Db): RoomStore {
  const one = async (rows: Promise<RoomRow[]>) => (await rows)[0] ?? null;
  return {
    async insert(input) {
      const rows = await db.insert(rooms).values(input).onConflictDoNothing().returning();
      return rows[0] ?? null;
    },
    findByCode: (code) => one(db.select().from(rooms).where(eq(rooms.code, code)).limit(1)),
    findById: (id) => one(db.select().from(rooms).where(eq(rooms.id, id)).limit(1)),
    listOpen: () => db.select().from(rooms).where(isNull(rooms.closedAt)),
    update: (id, patch) => one(db.update(rooms).set(patch).where(eq(rooms.id, id)).returning()),
    async close(id) {
      const rows = await db
        .update(rooms)
        .set({ closedAt: new Date() })
        .where(and(eq(rooms.id, id), isNull(rooms.closedAt)))
        .returning({ id: rooms.id });
      return rows.length > 0;
    },
  };
}
