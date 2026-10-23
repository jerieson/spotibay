import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  LikesResponse,
  ListenHistoryResponse,
  PlaylistAddResponse,
  PlaylistDetail,
  PlaylistListResponse,
  PlaylistResponse,
  RoomResponse,
  SharedPlaylistResponse,
} from '@spotibay/shared';
import { createHarness, joinRoom, next, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const vid = (n: number) => `video${String(n).padStart(6, '0')}`;
const LIST = 'PLabcdefghijklmnop';

beforeEach(async () => {
  await h.redis.flushdb();
  await h.db.execute('truncate table playlists, likes, listen_history, tracks cascade');
  h.videos.clear();
  h.playlistPages.clear();
  for (let i = 1; i <= 8; i++) h.videos.set(vid(i), { durationSec: 120, title: `Song ${i}` });
  h.videos.set(vid(9), { durationSec: 120, embeddable: false });
  await h.settings.set('features.playlistImport', true, null);
  await h.settings.set('limits.maxPlaylistImportItems', 200, null);
});

type Guest = Awaited<ReturnType<Harness['guest']>>;

async function create(g: Guest, name = 'Mix'): Promise<PlaylistDetail> {
  const res = await g.api<PlaylistResponse>('POST', '/playlists', { name });
  expect(res.status).toBe(201);
  return res.body.playlist;
}

const add = (g: Guest, id: string, ...videoIds: string[]) =>
  g.api<PlaylistAddResponse>('POST', `/playlists/${id}/items`, { videoIds });
const ids = (p: PlaylistDetail) => p.items.map((i) => i.track.videoId);

describe('playlists CRUD', () => {
  it('requires a session', async () => {
    expect((await fetch(`${h.baseUrl}/api/playlists`)).status).toBe(401);
  });

  it('creates, lists, renames and deletes', async () => {
    const g = await h.guest();
    const p = await create(g, '  Road trip ');
    expect(p).toMatchObject({ name: 'Road trip', isPublic: false, itemCount: 0, items: [] });
    expect(p.shareSlug).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect((await g.api('POST', '/playlists', { name: '   ' })).status).toBe(400);

    const list = await g.api<PlaylistListResponse>('GET', '/playlists');
    expect(list.body.playlists.map((x) => x.name)).toEqual(['Road trip']);

    const renamed = await g.api<PlaylistResponse>('PATCH', `/playlists/${p.id}`, { name: 'Trip' });
    expect(renamed.body.playlist.name).toBe('Trip');
    expect((await g.api('PATCH', `/playlists/${p.id}`, {})).status).toBe(400);

    expect((await g.api('DELETE', `/playlists/${p.id}`)).status).toBe(204);
    expect((await g.api('GET', `/playlists/${p.id}`)).status).toBe(404);
  });

  it('keeps playlists private to their owner', async () => {
    const owner = await h.guest();
    const other = await h.guest();
    const p = await create(owner);
    expect((await other.api('GET', `/playlists/${p.id}`)).status).toBe(403);
    expect((await other.api('PATCH', `/playlists/${p.id}`, { name: 'x' })).status).toBe(403);
    expect((await other.api('DELETE', `/playlists/${p.id}`)).status).toBe(403);
    expect((await add(other, p.id, vid(1))).status).toBe(403);
    expect((await other.api('GET', '/playlists/not-a-uuid')).status).toBe(404);
  });

  it('limits playlists per user', async () => {
    const g = await h.guest();
    for (let i = 0; i < 50; i++) await create(g, `P${i}`);
    expect((await g.api('POST', '/playlists', { name: 'one more' })).status).toBe(409);
  });
});

describe('playlist items', () => {
  it('adds playable tracks once, skipping duplicates, unplayable and unknown ones', async () => {
    const g = await h.guest();
    const p = await create(g);
    const res = await add(g, p.id, vid(1), vid(2), vid(1), vid(9), vid(10));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ added: 2, skipped: 2 });
    expect(ids(res.body.playlist)).toEqual([vid(1), vid(2)]);
    expect(res.body.playlist.thumbnailUrl).toContain(vid(1));

    const again = await add(g, p.id, vid(2), vid(3));
    expect(again.body).toMatchObject({ added: 1, skipped: 1 });
    expect(ids(again.body.playlist)).toEqual([vid(1), vid(2), vid(3)]);
  });

  it('validates the body', async () => {
    const g = await h.guest();
    const p = await create(g);
    expect((await g.api('POST', `/playlists/${p.id}/items`, { videoIds: [] })).status).toBe(400);
    expect((await g.api('POST', `/playlists/${p.id}/items`, { videoIds: ['bad'] })).status).toBe(
      400,
    );
  });

  it('removes and reorders items, keeping positions gapless', async () => {
    const g = await h.guest();
    const p = await create(g);
    const { body } = await add(g, p.id, vid(1), vid(2), vid(3), vid(4));
    const [a, b, , d] = body.playlist.items;

    const moved = await g.api<PlaylistResponse>('PATCH', `/playlists/${p.id}/items/${d!.id}`, {
      toIndex: 0,
    });
    expect(ids(moved.body.playlist)).toEqual([vid(4), vid(1), vid(2), vid(3)]);

    const toEnd = await g.api<PlaylistResponse>('PATCH', `/playlists/${p.id}/items/${d!.id}`, {
      toIndex: 99,
    });
    expect(ids(toEnd.body.playlist)).toEqual([vid(1), vid(2), vid(3), vid(4)]);

    const removed = await g.api<PlaylistResponse>('DELETE', `/playlists/${p.id}/items/${a!.id}`);
    expect(ids(removed.body.playlist)).toEqual([vid(2), vid(3), vid(4)]);
    expect(removed.body.playlist.itemCount).toBe(3);

    const next2 = await add(g, p.id, vid(5));
    expect(ids(next2.body.playlist)).toEqual([vid(2), vid(3), vid(4), vid(5)]);
    expect(
      (await g.api('PATCH', `/playlists/${p.id}/items/${b!.id}`, { toIndex: -1 })).status,
    ).toBe(400);
    expect(
      (
        await g.api('PATCH', `/playlists/${p.id}/items/00000000-0000-4000-8000-000000000000`, {
          toIndex: 0,
        })
      ).status,
    ).toBe(404);
  });
});

describe('sharing', () => {
  it('shows public playlists to anyone with the link and hides private ones', async () => {
    const owner = await h.guest();
    const viewer = await h.guest();
    const p = await create(owner, 'Shared');
    await add(owner, p.id, vid(1), vid(2));

    expect((await viewer.api('GET', `/playlists/shared/${p.shareSlug}`)).status).toBe(404);
    const own = await owner.api<SharedPlaylistResponse>('GET', `/playlists/shared/${p.shareSlug}`);
    expect(own.body.playlist.isOwner).toBe(true);

    await owner.api('PATCH', `/playlists/${p.id}`, { isPublic: true });
    const seen = await viewer.api<SharedPlaylistResponse>(
      'GET',
      `/playlists/shared/${p.shareSlug}`,
    );
    expect(seen.status).toBe(200);
    expect(seen.body.playlist).toMatchObject({ name: 'Shared', isOwner: false, itemCount: 2 });
    expect(seen.body.playlist.owner.displayName).toBe(owner.user.displayName);
    expect((await viewer.api('GET', '/playlists/shared/no')).status).toBe(404);
  });

  it('copies a viewable playlist into the viewer’s library', async () => {
    const owner = await h.guest();
    const viewer = await h.guest();
    const p = await create(owner, 'Original');
    await add(owner, p.id, vid(3), vid(1));

    const denied = await viewer.api('POST', `/playlists/shared/${p.shareSlug}/copy`);
    expect(denied.status).toBe(404);

    await owner.api('PATCH', `/playlists/${p.id}`, { isPublic: true });
    const copy = await viewer.api<PlaylistResponse>(
      'POST',
      `/playlists/shared/${p.shareSlug}/copy`,
    );
    expect(copy.status).toBe(201);
    expect(copy.body.playlist).toMatchObject({ name: 'Original', isPublic: false });
    expect(copy.body.playlist.shareSlug).not.toBe(p.shareSlug);
    expect(ids(copy.body.playlist)).toEqual([vid(3), vid(1)]);
    expect(
      (await viewer.api<PlaylistListResponse>('GET', '/playlists')).body.playlists,
    ).toHaveLength(1);
  });
});

describe('import from YouTube', () => {
  const url = `https://www.youtube.com/playlist?list=${LIST}`;

  it('imports playable videos in order and reports how many were skipped', async () => {
    h.playlistPages.set(LIST, [vid(1), vid(9), vid(2), vid(1), vid(10), vid(3)]);
    const g = await h.guest();
    const res = await g.api<PlaylistAddResponse>('POST', '/playlists/import', {
      url,
      name: 'Mine',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ added: 3, skipped: 2 });
    expect(res.body.playlist.name).toBe('Mine');
    expect(ids(res.body.playlist)).toEqual([vid(1), vid(2), vid(3)]);
  });

  it('is capped by limits.maxPlaylistImportItems', async () => {
    h.playlistPages.set(LIST, [vid(1), vid(2), vid(3), vid(4), vid(5)]);
    await h.settings.set('limits.maxPlaylistImportItems', 3, null);
    const g = await h.guest();
    const res = await g.api<PlaylistAddResponse>('POST', '/playlists/import', { url });
    expect(ids(res.body.playlist)).toEqual([vid(1), vid(2), vid(3)]);
    expect(res.body.playlist.name).toBe('Imported playlist');
  });

  it('honours the feature flag and rejects bad, missing and empty playlists', async () => {
    const g = await h.guest();
    h.playlistPages.set(LIST, [vid(1)]);
    await h.settings.set('features.playlistImport', false, null);
    expect((await g.api('POST', '/playlists/import', { url })).status).toBe(403);
    await h.settings.set('features.playlistImport', true, null);

    const bad = await g.api<{ error: string }>('POST', '/playlists/import', {
      url: 'https://youtu.be/dQw4w9WgXcQ',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_playlist_url');
    const missing = await g.api('POST', '/playlists/import', {
      url: 'https://www.youtube.com/playlist?list=PLmissingmissing',
    });
    expect(missing.status).toBe(404);

    h.playlistPages.set(LIST, [vid(9)]);
    expect((await g.api('POST', '/playlists/import', { url })).status).toBe(422);
    expect((await g.api<PlaylistListResponse>('GET', '/playlists')).body.playlists).toEqual([]);
  });
});

describe('likes', () => {
  it('likes and unlikes known tracks, newest first', async () => {
    const g = await h.guest();
    const p = await create(g);
    await add(g, p.id, vid(1), vid(2));

    expect((await g.api('PUT', `/likes/${vid(1)}`)).status).toBe(204);
    expect((await g.api('PUT', `/likes/${vid(1)}`)).status).toBe(204);
    expect((await g.api('PUT', `/likes/${vid(2)}`)).status).toBe(204);
    expect((await g.api('PUT', `/likes/${vid(7)}`)).status).toBe(404);
    expect((await g.api('PUT', '/likes/bad')).status).toBe(400);

    const list = await g.api<LikesResponse>('GET', '/likes');
    expect(list.body.tracks.map((t) => t.videoId)).toEqual([vid(2), vid(1)]);

    expect((await g.api('DELETE', `/likes/${vid(2)}`)).status).toBe(204);
    expect((await g.api<LikesResponse>('GET', '/likes')).body.tracks.map((t) => t.videoId)).toEqual(
      [vid(1)],
    );

    const other = await h.guest();
    expect((await other.api<LikesResponse>('GET', '/likes')).body.tracks).toEqual([]);
  });
});

describe('listening history and saving room history', () => {
  async function playTwo() {
    const host = await h.guest();
    const code = (await host.api<RoomResponse>('POST', '/rooms', { name: 'Hist room' })).body.room
      .code;
    const socket = await host.socket();
    await joinRoom(socket, code);
    for (const n of [1, 2]) h.videos.set(vid(n), { durationSec: 1, title: `Song ${n}` });
    // Each track ends by itself after a second; wait for the second to start playing.
    socket.emit('queue:add', { url: vid(1) });
    await next(socket, 'playback:state', (s) => s.item?.track.videoId === vid(1));
    socket.emit('queue:add', { url: vid(2) });
    await next(socket, 'playback:state', (s) => s.item?.track.videoId === vid(2), 4000);
    await next(socket, 'playback:state', (s) => s.status === 'idle', 4000);
    return { host, code };
  }

  it('lists what the user heard, newest first, with paging', async () => {
    const { host } = await playTwo();
    const res = await host.api<ListenHistoryResponse>('GET', '/me/history');
    expect(res.body.entries.map((e) => e.track.videoId)).toEqual([vid(2), vid(1)]);
    expect(res.body.nextBefore).toBeNull();

    const older = await host.api<ListenHistoryResponse>(
      'GET',
      `/me/history?before=${res.body.entries[0]!.id}`,
    );
    expect(older.body.entries.map((e) => e.track.videoId)).toEqual([vid(1)]);
    expect((await host.api('GET', '/me/history?before=abc')).status).toBe(400);
    expect(
      (await (await h.guest()).api<ListenHistoryResponse>('GET', '/me/history')).body.entries,
    ).toEqual([]);
  });

  it('saves room history as a playlist in play order, for members only', async () => {
    const { host, code } = await playTwo();
    const outsider = await h.guest();
    expect((await outsider.api('POST', `/rooms/${code}/history/playlist`, {})).status).toBe(403);

    const socket = await host.socket();
    await joinRoom(socket, code);
    const res = await host.api<PlaylistAddResponse>('POST', `/rooms/${code}/history/playlist`, {});
    expect(res.status).toBe(201);
    expect(res.body.playlist.name).toBe('Hist room history');
    expect(ids(res.body.playlist)).toEqual([vid(1), vid(2)]);
    expect((await host.api('POST', '/rooms/ZZZZZZ/history/playlist', {})).status).toBe(404);
  });
});
