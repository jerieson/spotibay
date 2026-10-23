import { isIP } from 'node:net';
import {
  QUOTA_HISTORY_DAYS,
  type AdminBan,
  type AdminChatMessage,
  type AdminQuotaResponse,
  type AdminRoomDetail,
  type AdminRoomSummary,
  type AdminStats,
  type AdminUser,
  type AdminUserDetail,
  type CreateBanBody,
  type SettingKey,
  type SettingsValues,
} from '@spotibay/shared';
import type { AdminDataStore, AdminUserRow, ChatFilter } from './admin-store.js';
import type { AuditFilter, AuditService } from './audit.js';
import type { ChatService } from './chat.js';
import type { PlaybackService } from './playback.js';
import type { Presence } from './presence.js';
import type { RoomRow, RoomService } from './rooms.js';
import { SettingsValidationError, type SettingsService } from './settings.js';
import { quotaDate } from './youtube.js';

export type AdminErrorCode = 'not_found' | 'invalid_request';

export class AdminError extends Error {
  constructor(
    readonly code: AdminErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

/** What the admin service needs from the socket layer; it registers itself with `attach`. */
export interface AdminControl {
  /** Removes `userId` from a room and tells their sockets. */
  kickUser(roomId: string, userId: string, reason: 'kicked' | 'banned'): Promise<void>;
  /** Disconnects every socket of a user. */
  disconnectUser(userId: string): Promise<void>;
  disconnectIp(ip: string): Promise<void>;
  userIps(userId: string): Promise<string[]>;
  onlineUserCount(): Promise<number>;
}

export interface AdminServiceDeps {
  store: AdminDataStore;
  audit: AuditService;
  rooms: RoomService;
  presence: Presence;
  playback: Pick<PlaybackService, 'snapshot'>;
  chat: Pick<ChatService, 'announceDeleted'>;
  settings: Pick<SettingsService, 'all' | 'set' | 'version'>;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` minus `days`, done on the calendar so daylight saving cannot skip or repeat a day. */
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function createAdminService({
  store,
  audit,
  rooms,
  presence,
  playback,
  chat,
  settings,
  now = () => new Date(),
}: AdminServiceDeps) {
  let control: AdminControl | null = null;

  async function summarize(row: RoomRow): Promise<AdminRoomSummary> {
    const [memberCount, snapshot, host] = await Promise.all([
      presence.count(row.id),
      playback.snapshot(row.id),
      store.findUser(row.ownerId),
    ]);
    const track = snapshot.playback.item?.track;
    return {
      code: row.code,
      name: row.name,
      visibility: row.visibility,
      hostId: row.ownerId,
      hostName: host?.displayName ?? null,
      queueMode: row.queueMode,
      createdAt: row.createdAt.toISOString(),
      memberCount,
      queueLength: snapshot.queue.length,
      nowPlaying: track
        ? {
            videoId: track.videoId,
            title: track.title,
            channelTitle: track.channelTitle,
            thumbnailUrl: track.thumbnailUrl,
          }
        : null,
    };
  }

  async function openRoom(code: string): Promise<RoomRow> {
    const row = await rooms.findByCode(code.toUpperCase());
    if (!row || row.closedAt) throw new AdminError('not_found', 'Room not found');
    return row;
  }

  async function listRooms(): Promise<AdminRoomSummary[]> {
    const summaries = await Promise.all((await rooms.listOpen()).map(summarize));
    return summaries.sort(
      (a, b) => b.memberCount - a.memberCount || b.createdAt.localeCompare(a.createdAt),
    );
  }

  async function getRoom(code: string): Promise<AdminRoomDetail> {
    const row = await openRoom(code);
    const [summary, members, snapshot] = await Promise.all([
      summarize(row),
      presence.list(row.id),
      playback.snapshot(row.id),
    ]);
    return { ...summary, members, playback: snapshot.playback, queue: snapshot.queue };
  }

  async function closeRoom(adminId: string, code: string): Promise<void> {
    const row = await openRoom(code);
    await rooms.close(row.code, null, 'admin');
    await audit.record({
      adminId,
      action: 'room.close',
      targetType: 'room',
      targetId: row.code,
      details: { name: row.name },
    });
  }

  async function kick(adminId: string, code: string, userId: string): Promise<void> {
    const row = await openRoom(code);
    const member = await presence.get(row.id, userId);
    if (!member) throw new AdminError('not_found', 'That person is not in the room');
    await control?.kickUser(row.id, userId, 'kicked');
    await audit.record({
      adminId,
      action: 'user.kick',
      targetType: 'user',
      targetId: userId,
      details: { room: row.code, name: member.displayName },
    });
  }

  async function toAdminUsers(rows: AdminUserRow[]): Promise<AdminUser[]> {
    const banned = await store.bannedUserIds(rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      avatar: r.avatar,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      banned: banned.has(r.id),
    }));
  }

  const listUsers = async (q: string) => toAdminUsers(await store.searchUsers(q, 50));

  async function getUser(id: string): Promise<AdminUserDetail> {
    const row = await store.findUser(id);
    if (!row) throw new AdminError('not_found', 'User not found');
    const [user] = await toAdminUsers([row]);
    const present: AdminUserDetail['rooms'] = [];
    for (const room of await rooms.listOpen()) {
      if (await presence.get(room.id, id)) present.push({ code: room.code, name: room.name });
    }
    return {
      ...user!,
      rooms: present,
      ips: (await control?.userIps(id)) ?? [],
      bans: await store.listBans({ includeExpired: true, userId: id }),
    };
  }

  async function ban(adminId: string, body: CreateBanBody): Promise<AdminBan> {
    if (body.type === 'ip' && isIP(body.value) === 0) {
      throw new AdminError('invalid_request', 'That is not an IP address');
    }
    if (body.type === 'user' && !(await store.findUser(body.value))) {
      throw new AdminError('not_found', 'User not found');
    }
    const expiresAt =
      body.durationMinutes === null
        ? null
        : new Date(now().getTime() + body.durationMinutes * 60_000);
    const created = await store.insertBan({
      type: body.type,
      value: body.value,
      reason: body.reason || null,
      adminId,
      expiresAt,
    });
    if (body.type === 'user') await control?.disconnectUser(body.value);
    else await control?.disconnectIp(body.value);
    await audit.record({
      adminId,
      action: 'ban.create',
      targetType: body.type,
      targetId: body.value,
      details: {
        banId: created.id,
        reason: created.reason,
        expiresAt: created.expiresAt,
        ...(created.userName ? { name: created.userName } : {}),
      },
    });
    return created;
  }

  async function unban(adminId: string, id: number): Promise<AdminBan> {
    const ended = await store.endBan(id);
    if (!ended) throw new AdminError('not_found', 'No active ban with that id');
    await audit.record({
      adminId,
      action: 'ban.remove',
      targetType: ended.type,
      targetId: ended.value,
      details: { banId: id },
    });
    return ended;
  }

  const listChat = (filter: ChatFilter): Promise<AdminChatMessage[]> => store.listChat(filter);

  async function deleteMessage(adminId: string, id: string): Promise<void> {
    const deleted = await store.deleteChatMessage(id, adminId);
    if (!deleted) throw new AdminError('not_found', 'Message not found');
    chat.announceDeleted(deleted.roomId, id);
    await audit.record({ adminId, action: 'chat.delete', targetType: 'message', targetId: id });
  }

  async function quota(): Promise<AdminQuotaResponse> {
    const today = quotaDate(now());
    const first = shiftDate(today, -(QUOTA_HISTORY_DAYS - 1));
    const rows = new Map((await store.quotaSince(first)).map((r) => [r.date, r]));
    const days = Array.from({ length: QUOTA_HISTORY_DAYS }, (_, i) => {
      const date = shiftDate(first, i);
      const row = rows.get(date);
      return { date, units: row?.units ?? 0, searchCalls: row?.searchCalls ?? 0 };
    });
    return {
      today: days.at(-1)!,
      searchCallBudget: settings.all()['search.dailySearchCallBudget'],
      days,
    };
  }

  async function updateSetting(adminId: string, key: SettingKey, value: unknown) {
    try {
      const change = await settings.set(key, value, adminId);
      await audit.record({
        adminId,
        action: 'settings.update',
        targetType: 'setting',
        targetId: key,
        details: { from: change.previous, to: change.value },
      });
      return change;
    } catch (err) {
      if (err instanceof SettingsValidationError)
        throw new AdminError('invalid_request', err.message);
      throw err;
    }
  }

  async function stats(): Promise<AdminStats> {
    return {
      rooms: (await rooms.listOpen()).length,
      usersOnline: (await control?.onlineUserCount()) ?? 0,
    };
  }

  return {
    attach(next: AdminControl) {
      control = next;
    },
    stats,
    listRooms,
    getRoom,
    closeRoom,
    kick,
    listUsers,
    getUser,
    ban,
    unban,
    listBans: store.listBans,
    listChat,
    deleteMessage,
    quota,
    updateSetting,
    getSettings: (): { settings: SettingsValues; version: number } => ({
      settings: settings.all(),
      version: settings.version,
    }),
    listAudit: (filter: AuditFilter) => audit.list(filter),
    recordAudit: audit.record,
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
