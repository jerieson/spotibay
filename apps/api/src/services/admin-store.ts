import { and, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { AdminBan, AdminChatMessage, Avatar, AuditEntry } from '@spotibay/shared';
import type { Db } from '../db/client.js';
import {
  adminAuditLog,
  admins,
  apiQuotaUsage,
  bans,
  chatMessages,
  rooms,
  users,
} from '../db/schema.js';
import type { AdminStore } from './admin-auth.js';
import type { AuditStore } from './audit.js';

export interface AdminUserRow {
  id: string;
  displayName: string;
  avatar: Avatar;
  createdAt: Date;
  lastSeenAt: Date;
}

export interface BanInput {
  type: 'user' | 'ip';
  value: string;
  reason: string | null;
  adminId: string;
  expiresAt: Date | null;
}

export interface ChatFilter {
  roomCode?: string;
  userId?: string;
  q?: string;
  limit: number;
}

/** Everything the admin panel reads or writes directly in Postgres. */
export interface AdminDataStore {
  searchUsers(q: string, limit: number): Promise<AdminUserRow[]>;
  findUser(id: string): Promise<AdminUserRow | null>;
  /** Of `ids`, the users with an unexpired user ban. */
  bannedUserIds(ids: string[]): Promise<Set<string>>;
  insertBan(input: BanInput): Promise<AdminBan>;
  listBans(opts: { includeExpired: boolean; userId?: string }): Promise<AdminBan[]>;
  /** Ends a ban now. Resolves `null` when it does not exist or already ended. */
  endBan(id: number): Promise<AdminBan | null>;
  listChat(filter: ChatFilter): Promise<AdminChatMessage[]>;
  /** Marks a message deleted. Resolves the room id, or `null` when there is nothing to delete. */
  deleteChatMessage(id: string, adminId: string): Promise<{ roomId: string } | null>;
  quotaSince(date: string): Promise<{ date: string; units: number; searchCalls: number }[]>;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function createAdminStore(db: Db): AdminStore {
  const columns = { id: admins.id, username: admins.username };
  return {
    async upsert(username, passwordHash) {
      const [row] = await db
        .insert(admins)
        .values({ username, passwordHash })
        .onConflictDoUpdate({ target: admins.username, set: { passwordHash } })
        .returning(columns);
      return row!;
    },
    async findByUsername(username) {
      const [row] = await db
        .select({ ...columns, passwordHash: admins.passwordHash })
        .from(admins)
        .where(eq(admins.username, username))
        .limit(1);
      return row ?? null;
    },
    async findById(id) {
      const [row] = await db.select(columns).from(admins).where(eq(admins.id, id)).limit(1);
      return row ?? null;
    },
    async touchLogin(id) {
      await db.update(admins).set({ lastLoginAt: new Date() }).where(eq(admins.id, id));
    },
  };
}

export function createAuditStore(db: Db): AuditStore {
  return {
    async insert(input) {
      await db.insert(adminAuditLog).values({
        adminId: input.adminId,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        details: input.details ?? {},
      });
    },
    async list({ action, targetType, before, limit }) {
      const rows = await db
        .select({
          id: adminAuditLog.id,
          adminUsername: admins.username,
          action: adminAuditLog.action,
          targetType: adminAuditLog.targetType,
          targetId: adminAuditLog.targetId,
          details: adminAuditLog.details,
          createdAt: adminAuditLog.createdAt,
        })
        .from(adminAuditLog)
        .leftJoin(admins, eq(admins.id, adminAuditLog.adminId))
        .where(
          and(
            action ? eq(adminAuditLog.action, action) : undefined,
            targetType ? eq(adminAuditLog.targetType, targetType) : undefined,
            before ? lt(adminAuditLog.id, before) : undefined,
          ),
        )
        .orderBy(desc(adminAuditLog.id))
        .limit(limit);
      return rows.map((r): AuditEntry => ({ ...r, createdAt: r.createdAt.toISOString() }));
    },
  };
}

export function createAdminDataStore(db: Db): AdminDataStore {
  const activeBan = () => or(isNull(bans.expiresAt), gt(bans.expiresAt, new Date()));

  async function withUserNames<T extends { type: 'user' | 'ip'; value: string }>(rows: T[]) {
    const ids = rows.filter((r) => r.type === 'user').map((r) => r.value);
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const found = await db
        .select({ id: users.id, name: users.displayName })
        .from(users)
        .where(inArray(users.id, ids));
      for (const u of found) names.set(u.id, u.name);
    }
    return rows.map((r) => ({
      ...r,
      userName: r.type === 'user' ? (names.get(r.value) ?? null) : null,
    }));
  }

  async function toBans(rows: (typeof bans.$inferSelect)[]): Promise<AdminBan[]> {
    const now = Date.now();
    return (await withUserNames(rows)).map((r) => ({
      id: r.id,
      type: r.type,
      value: r.value,
      userName: r.userName,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
      active: r.expiresAt === null || r.expiresAt.getTime() > now,
    }));
  }

  const userColumns = {
    id: users.id,
    displayName: users.displayName,
    avatar: users.avatar,
    createdAt: users.createdAt,
    lastSeenAt: users.lastSeenAt,
  };

  return {
    searchUsers: (q, limit) =>
      db
        .select(userColumns)
        .from(users)
        .where(q ? ilike(users.displayName, `%${escapeLike(q)}%`) : undefined)
        .orderBy(desc(users.lastSeenAt))
        .limit(limit),
    async findUser(id) {
      const [row] = await db.select(userColumns).from(users).where(eq(users.id, id)).limit(1);
      return row ?? null;
    },
    async bannedUserIds(ids) {
      if (ids.length === 0) return new Set();
      const rows = await db
        .select({ value: bans.value })
        .from(bans)
        .where(and(eq(bans.type, 'user'), inArray(bans.value, ids), activeBan()));
      return new Set(rows.map((r) => r.value));
    },
    async insertBan(input) {
      const [row] = await db
        .insert(bans)
        .values({
          type: input.type,
          value: input.value,
          reason: input.reason,
          createdByAdminId: input.adminId,
          expiresAt: input.expiresAt,
        })
        .returning();
      return (await toBans([row!]))[0]!;
    },
    async listBans({ includeExpired, userId }) {
      const rows = await db
        .select()
        .from(bans)
        .where(
          and(
            includeExpired ? undefined : activeBan(),
            userId ? and(eq(bans.type, 'user'), eq(bans.value, userId)) : undefined,
          ),
        )
        .orderBy(desc(bans.id))
        .limit(200);
      return toBans(rows);
    },
    async endBan(id) {
      const [row] = await db
        .update(bans)
        .set({ expiresAt: new Date() })
        .where(and(eq(bans.id, id), activeBan()))
        .returning();
      return row ? (await toBans([row]))[0]! : null;
    },
    async listChat({ roomCode, userId, q, limit }) {
      const rows = await db
        .select({
          id: chatMessages.id,
          roomCode: rooms.code,
          roomName: rooms.name,
          userId: chatMessages.userId,
          userName: users.displayName,
          body: chatMessages.body,
          createdAt: chatMessages.createdAt,
          deletedAt: chatMessages.deletedAt,
        })
        .from(chatMessages)
        .innerJoin(rooms, eq(rooms.id, chatMessages.roomId))
        .innerJoin(users, eq(users.id, chatMessages.userId))
        .where(
          and(
            roomCode ? eq(rooms.code, roomCode.toUpperCase()) : undefined,
            userId ? eq(chatMessages.userId, userId) : undefined,
            q ? ilike(chatMessages.body, `%${escapeLike(q)}%`) : undefined,
          ),
        )
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit);
      return rows.map(({ deletedAt, createdAt, ...r }) => ({
        ...r,
        createdAt: createdAt.toISOString(),
        deleted: deletedAt !== null,
      }));
    },
    async deleteChatMessage(id, adminId) {
      const [row] = await db
        .update(chatMessages)
        .set({ deletedAt: new Date(), deletedByAdminId: adminId })
        .where(and(eq(chatMessages.id, id), isNull(chatMessages.deletedAt)))
        .returning({ roomId: chatMessages.roomId });
      return row ?? null;
    },
    async quotaSince(date) {
      return db
        .select({
          date: apiQuotaUsage.date,
          units: apiQuotaUsage.units,
          searchCalls: apiQuotaUsage.searchCalls,
        })
        .from(apiQuotaUsage)
        .where(sql`${apiQuotaUsage.date} >= ${date}`);
    },
  };
}
