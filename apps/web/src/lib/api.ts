import {
  healthResponseSchema,
  likesResponseSchema,
  listenHistoryResponseSchema,
  playlistAddResponseSchema,
  playlistListResponseSchema,
  playlistResponseSchema,
  sharedPlaylistResponseSchema,
  siteResponseSchema,
  meResponseSchema,
  recoveryCodeResponseSchema,
  roomHistoryResponseSchema,
  roomListResponseSchema,
  resolveResponseSchema,
  roomResponseSchema,
  searchResponseSchema,
  sessionResponseSchema,
  suggestResponseSchema,
  type CatalogTrack,
  type CreateRoomBody,
  type HealthResponse,
  type HistoryEntry,
  type ListenHistoryResponse,
  type PlaylistAddResponse,
  type PlaylistDetail,
  type PlaylistSummary,
  type SharedPlaylist,
  type Track,
  type UpdatePlaylistBody,
  type ResolveResponse,
  type RoomSummary,
  type SearchResponse,
  type SessionResponse,
  type SiteResponse,
  type UpdateMeBody,
  type User,
} from '@spotibay/shared';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T extends z.ZodType>(
  schema: T,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<z.infer<T>> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    credentials: 'same-origin',
    headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (json ?? {}) as { error?: string; message?: string };
    throw new ApiError(
      res.status,
      err.error ?? 'unknown',
      err.message ?? `Request failed (${res.status})`,
    );
  }
  return schema.parse(json);
}

export async function fetchHealth(): Promise<HealthResponse> {
  return request(healthResponseSchema, '/api/health');
}

export function fetchSite(): Promise<SiteResponse> {
  return request(siteResponseSchema, '/api/site');
}

export function startSession(): Promise<SessionResponse> {
  return request(sessionResponseSchema, '/api/session', { method: 'POST' });
}

export function recoverSession(code: string): Promise<SessionResponse> {
  return request(sessionResponseSchema, '/api/session/recover', { method: 'POST', body: { code } });
}

export async function regenerateRecoveryCode(): Promise<string> {
  const res = await request(recoveryCodeResponseSchema, '/api/session/recovery-code', {
    method: 'POST',
  });
  return res.recoveryCode;
}

export async function updateMe(body: UpdateMeBody): Promise<User> {
  const res = await request(meResponseSchema, '/api/me', { method: 'PATCH', body });
  return res.user;
}

export async function createRoom(body: CreateRoomBody): Promise<RoomSummary> {
  const res = await request(roomResponseSchema, '/api/rooms', { method: 'POST', body });
  return res.room;
}

export async function fetchRooms(): Promise<RoomSummary[]> {
  return (await request(roomListResponseSchema, '/api/rooms')).rooms;
}

export async function fetchRoom(code: string): Promise<RoomSummary> {
  return (await request(roomResponseSchema, `/api/rooms/${encodeURIComponent(code)}`)).room;
}

export function searchTracks(q: string): Promise<SearchResponse> {
  return request(searchResponseSchema, `/api/search?q=${encodeURIComponent(q)}`);
}

export async function suggestTracks(q: string): Promise<CatalogTrack[]> {
  const res = await request(
    suggestResponseSchema,
    `/api/search/suggest?q=${encodeURIComponent(q)}`,
  );
  return res.suggestions;
}

export function resolveTrack(catalogId: string): Promise<ResolveResponse> {
  return request(resolveResponseSchema, '/api/search/resolve', {
    method: 'POST',
    body: { catalogId },
  });
}

export async function fetchRoomHistory(code: string): Promise<HistoryEntry[]> {
  const res = await request(
    roomHistoryResponseSchema,
    `/api/rooms/${encodeURIComponent(code)}/history`,
  );
  return res.history;
}

/** For endpoints that answer 204. */
async function send(path: string, method: string, body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.ok) return;
  const err = ((await res.json().catch(() => null)) ?? {}) as { error?: string; message?: string };
  throw new ApiError(
    res.status,
    err.error ?? 'unknown',
    err.message ?? `Request failed (${res.status})`,
  );
}

export async function fetchPlaylists(): Promise<PlaylistSummary[]> {
  return (await request(playlistListResponseSchema, '/api/playlists')).playlists;
}

export async function fetchPlaylist(id: string): Promise<PlaylistDetail> {
  return (await request(playlistResponseSchema, `/api/playlists/${id}`)).playlist;
}

export async function createPlaylist(name: string): Promise<PlaylistDetail> {
  return (
    await request(playlistResponseSchema, '/api/playlists', { method: 'POST', body: { name } })
  ).playlist;
}

export async function updatePlaylist(
  id: string,
  body: UpdatePlaylistBody,
): Promise<PlaylistDetail> {
  return (await request(playlistResponseSchema, `/api/playlists/${id}`, { method: 'PATCH', body }))
    .playlist;
}

export function deletePlaylist(id: string): Promise<void> {
  return send(`/api/playlists/${id}`, 'DELETE');
}

export function addToPlaylist(id: string, videoIds: string[]): Promise<PlaylistAddResponse> {
  return request(playlistAddResponseSchema, `/api/playlists/${id}/items`, {
    method: 'POST',
    body: { videoIds },
  });
}

export async function removePlaylistItem(id: string, itemId: string): Promise<PlaylistDetail> {
  return (
    await request(playlistResponseSchema, `/api/playlists/${id}/items/${itemId}`, {
      method: 'DELETE',
    })
  ).playlist;
}

export async function reorderPlaylistItem(
  id: string,
  itemId: string,
  toIndex: number,
): Promise<PlaylistDetail> {
  return (
    await request(playlistResponseSchema, `/api/playlists/${id}/items/${itemId}`, {
      method: 'PATCH',
      body: { toIndex },
    })
  ).playlist;
}

export function importPlaylist(url: string, name?: string): Promise<PlaylistAddResponse> {
  return request(playlistAddResponseSchema, '/api/playlists/import', {
    method: 'POST',
    body: { url, name: name || undefined },
  });
}

export async function fetchSharedPlaylist(slug: string): Promise<SharedPlaylist> {
  return (
    await request(sharedPlaylistResponseSchema, `/api/playlists/shared/${encodeURIComponent(slug)}`)
  ).playlist;
}

export async function copySharedPlaylist(slug: string): Promise<PlaylistDetail> {
  return (
    await request(
      playlistResponseSchema,
      `/api/playlists/shared/${encodeURIComponent(slug)}/copy`,
      { method: 'POST' },
    )
  ).playlist;
}

export function saveRoomHistory(code: string): Promise<PlaylistAddResponse> {
  return request(
    playlistAddResponseSchema,
    `/api/rooms/${encodeURIComponent(code)}/history/playlist`,
    { method: 'POST', body: {} },
  );
}

export async function fetchLikes(): Promise<Track[]> {
  return (await request(likesResponseSchema, '/api/likes')).tracks;
}

export function setLiked(videoId: string, liked: boolean): Promise<void> {
  return send(`/api/likes/${videoId}`, liked ? 'PUT' : 'DELETE');
}

export function fetchListenHistory(before?: number): Promise<ListenHistoryResponse> {
  return request(
    listenHistoryResponseSchema,
    `/api/me/history${before === undefined ? '' : `?before=${before}`}`,
  );
}
