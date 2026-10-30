import {
  adminBanListResponseSchema,
  adminBanResponseSchema,
  adminChatListResponseSchema,
  adminMeResponseSchema,
  adminQuotaResponseSchema,
  adminRoomListResponseSchema,
  adminRoomResponseSchema,
  adminSettingsResponseSchema,
  adminStatsSchema,
  adminUserListResponseSchema,
  adminUserResponseSchema,
  auditListResponseSchema,
  type CreateBanBody,
} from '@spotibay/shared';
import type { z } from 'zod';
import { call as fetchApi } from '@/lib/api';

async function call(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const res = await fetchApi(`/api/admin${path}`, method, body);
  return res.json().catch(() => null);
}

const get = async <T extends z.ZodType>(schema: T, path: string): Promise<z.infer<T>> =>
  schema.parse(await call(path));

const qs = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== '') search.set(k, String(v));
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const adminApi = {
  me: async () => (await get(adminMeResponseSchema, '/me')).admin,
  login: (username: string, password: string) => call('/login', 'POST', { username, password }),
  logout: () => call('/logout', 'POST'),
  stats: () => get(adminStatsSchema, '/stats'),
  settings: () => get(adminSettingsResponseSchema, '/settings'),
  updateSetting: (key: string, value: unknown) => call(`/settings/${key}`, 'PUT', { value }),
  rooms: async () => (await get(adminRoomListResponseSchema, '/rooms')).rooms,
  room: async (code: string) => (await get(adminRoomResponseSchema, `/rooms/${code}`)).room,
  closeRoom: (code: string) => call(`/rooms/${code}/close`, 'POST'),
  kick: (code: string, userId: string) => call(`/rooms/${code}/kick`, 'POST', { userId }),
  users: async (q: string) => (await get(adminUserListResponseSchema, `/users${qs({ q })}`)).users,
  user: async (id: string) => (await get(adminUserResponseSchema, `/users/${id}`)).user,
  bans: async (includeExpired: boolean) =>
    (await get(adminBanListResponseSchema, `/bans?includeExpired=${includeExpired}`)).bans,
  ban: async (body: CreateBanBody) =>
    adminBanResponseSchema.parse(await call('/bans', 'POST', body)).ban,
  unban: (id: number) => call(`/bans/${id}`, 'DELETE'),
  chat: async (filter: { roomCode?: string; q?: string; userId?: string }) =>
    (await get(adminChatListResponseSchema, `/chat${qs(filter)}`)).messages,
  deleteMessage: (id: string) => call(`/chat/${id}`, 'DELETE'),
  quota: () => get(adminQuotaResponseSchema, '/quota'),
  audit: (filter: { action?: string; targetType?: string; before?: number }) =>
    get(auditListResponseSchema, `/audit${qs({ ...filter, limit: 50 })}`),
};
