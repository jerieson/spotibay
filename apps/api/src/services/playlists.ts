import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  MAX_PLAYLIST_ITEMS,
  MAX_PLAYLISTS_PER_USER,
  type PlaylistDetail,
  type PlaylistErrorCode,
  type PlaylistSummary,
  type SettingKey,
  type SettingsValues,
  type SharedPlaylist,
  type Track,
} from '@spotibay/shared';
import type { Db } from '../db/client.js';
import { playlistItems, playlists, tracks, users } from '../db/schema.js';
import { createKeyedLock } from '../lib/keyed-lock.js';
import { parsePlaylistId, YouTubeError, type YouTubeService } from './youtube.js';

export class PlaylistError extends Error {
  constructor(
    readonly code: PlaylistErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PlaylistError';
  }
}

export interface PlaylistServiceDeps {
  db: Db;
  youtube: Pick<YouTubeService, 'getVideos' | 'getPlaylistVideoIds'>;
  settings: { get<K extends SettingKey>(key: K): SettingsValues[K] };
  now?: () => Date;
}

type PlaylistRow = typeof playlists.$inferSelect;

export interface AddResult {
  playlist: PlaylistDetail;
  added: number;
  skipped: number;
}

const toTrack = (r: {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  durationSec: number;
}): Track => ({
  videoId: r.videoId,
  title: r.title,
  channelTitle: r.channelTitle,
  thumbnailUrl: r.thumbnailUrl,
  durationSec: r.durationSec,
});

const newSlug = () => randomBytes(9).toString('base64url');

export function createPlaylistService({
  db,
  youtube,
  settings,
  now = () => new Date(),
}: PlaylistServiceDeps) {
  const withLock = createKeyedLock();

  async function summarize(rows: PlaylistRow[]): Promise<PlaylistSummary[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const counts = await db
      .select({ playlistId: playlistItems.playlistId, n: count() })
      .from(playlistItems)
      .where(inArray(playlistItems.playlistId, ids))
      .groupBy(playlistItems.playlistId);
    const covers = await db
      .selectDistinctOn([playlistItems.playlistId], {
        playlistId: playlistItems.playlistId,
        thumbnailUrl: tracks.thumbnailUrl,
      })
      .from(playlistItems)
      .innerJoin(tracks, eq(tracks.videoId, playlistItems.videoId))
      .where(inArray(playlistItems.playlistId, ids))
      .orderBy(playlistItems.playlistId, asc(playlistItems.position));
    const countBy = new Map(counts.map((c) => [c.playlistId, c.n]));
    const coverBy = new Map(covers.map((c) => [c.playlistId, c.thumbnailUrl]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      isPublic: r.isPublic,
      shareSlug: r.shareSlug,
      itemCount: countBy.get(r.id) ?? 0,
      thumbnailUrl: coverBy.get(r.id) ?? null,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async function detail(row: PlaylistRow): Promise<PlaylistDetail> {
    const [summary] = await summarize([row]);
    const items = await db
      .select({
        id: playlistItems.id,
        videoId: tracks.videoId,
        title: tracks.title,
        channelTitle: tracks.channelTitle,
        thumbnailUrl: tracks.thumbnailUrl,
        durationSec: tracks.durationSec,
      })
      .from(playlistItems)
      .innerJoin(tracks, eq(tracks.videoId, playlistItems.videoId))
      .where(eq(playlistItems.playlistId, row.id))
      .orderBy(asc(playlistItems.position));
    if (!summary) throw new Error('playlist summary missing');
    return { ...summary, items: items.map((i) => ({ id: i.id, track: toTrack(i) })) };
  }

  async function findOwned(userId: string, playlistId: string): Promise<PlaylistRow> {
    const [row] = await db.select().from(playlists).where(eq(playlists.id, playlistId));
    if (!row) throw new PlaylistError('playlist_not_found', 'Playlist not found');
    if (row.ownerId !== userId) throw new PlaylistError('forbidden', 'This is not your playlist');
    return row;
  }

  async function touch(playlistId: string) {
    await db.update(playlists).set({ updatedAt: now() }).where(eq(playlists.id, playlistId));
  }

  async function createRow(userId: string, name: string): Promise<PlaylistRow> {
    const [{ n = 0 } = {}] = await db
      .select({ n: count() })
      .from(playlists)
      .where(eq(playlists.ownerId, userId));
    if (n >= MAX_PLAYLISTS_PER_USER) {
      throw new PlaylistError('too_many_playlists', 'You have too many playlists');
    }
    const [row] = await db
      .insert(playlists)
      .values({ ownerId: userId, name, shareSlug: newSlug(), updatedAt: now() })
      .returning();
    if (!row) throw new Error('playlist insert returned no row');
    return row;
  }

  /** Appends the videos (already in `tracks`) that the playlist doesn't have yet, up to its cap. */
  async function append(playlistId: string, videoIds: string[]): Promise<{ added: number }> {
    return withLock(playlistId, async () => {
      const existing = await db
        .select({ videoId: playlistItems.videoId, position: playlistItems.position })
        .from(playlistItems)
        .where(eq(playlistItems.playlistId, playlistId));
      const have = new Set(existing.map((e) => e.videoId));
      const fresh = [...new Set(videoIds)].filter((id) => !have.has(id));
      const room = Math.max(0, MAX_PLAYLIST_ITEMS - existing.length);
      const take = fresh.slice(0, room);
      if (take.length === 0) return { added: 0 };
      const last = existing.reduce((max, e) => Math.max(max, e.position), 0);
      await db
        .insert(playlistItems)
        .values(take.map((videoId, i) => ({ playlistId, videoId, position: last + i + 1 })));
      await touch(playlistId);
      return { added: take.length };
    });
  }

  /** Ids from `videoIds` that can be played, in order: known to YouTube, embeddable and not live. */
  async function playable(videoIds: string[], userId: string): Promise<string[]> {
    let found;
    try {
      found = await youtube.getVideos(videoIds, userId);
    } catch (err) {
      if (err instanceof YouTubeError) {
        if (err.code === 'user_limit') throw new PlaylistError('rate_limited', err.message);
        throw new PlaylistError('youtube_unavailable', 'Could not reach YouTube, try again later');
      }
      throw err;
    }
    return [...new Set(videoIds)].filter((id) => {
      const t = found.get(id);
      return t !== undefined && t.embeddable && t.durationSec > 0;
    });
  }

  /** Stored tracks for ids we already have (from a room's history or another playlist). */
  async function storedPlayable(videoIds: string[]): Promise<string[]> {
    if (videoIds.length === 0) return [];
    const rows = await db
      .select({ videoId: tracks.videoId })
      .from(tracks)
      .where(and(inArray(tracks.videoId, videoIds), eq(tracks.embeddable, true)));
    const ok = new Set(rows.map((r) => r.videoId));
    return videoIds.filter((id) => ok.has(id));
  }

  async function addResult(row: PlaylistRow, added: number, requested: number): Promise<AddResult> {
    return { playlist: await detail(row), added, skipped: requested - added };
  }

  /** Public playlists are visible to anyone with the link; private ones only to their owner. */
  async function findViewable(viewerId: string, slug: string): Promise<PlaylistRow> {
    const [row] = await db.select().from(playlists).where(eq(playlists.shareSlug, slug));
    if (!row || (!row.isPublic && row.ownerId !== viewerId)) {
      throw new PlaylistError('playlist_not_found', 'Playlist not found');
    }
    return row;
  }

  return {
    async list(userId: string): Promise<PlaylistSummary[]> {
      const rows = await db
        .select()
        .from(playlists)
        .where(eq(playlists.ownerId, userId))
        .orderBy(desc(playlists.updatedAt));
      return summarize(rows);
    },

    async create(userId: string, name: string): Promise<PlaylistDetail> {
      return detail(await createRow(userId, name));
    },

    async get(userId: string, playlistId: string): Promise<PlaylistDetail> {
      return detail(await findOwned(userId, playlistId));
    },

    async update(
      userId: string,
      playlistId: string,
      patch: { name?: string; isPublic?: boolean },
    ): Promise<PlaylistDetail> {
      await findOwned(userId, playlistId);
      const [row] = await db
        .update(playlists)
        .set({ ...patch, updatedAt: now() })
        .where(eq(playlists.id, playlistId))
        .returning();
      if (!row) throw new PlaylistError('playlist_not_found', 'Playlist not found');
      return detail(row);
    },

    async remove(userId: string, playlistId: string): Promise<void> {
      await findOwned(userId, playlistId);
      await db.delete(playlists).where(eq(playlists.id, playlistId));
    },

    async addVideos(userId: string, playlistId: string, videoIds: string[]): Promise<AddResult> {
      await findOwned(userId, playlistId);
      const ok = await playable(videoIds, userId);
      const { added } = await append(playlistId, ok);
      return addResult(await findOwned(userId, playlistId), added, new Set(videoIds).size);
    },

    async removeItem(userId: string, playlistId: string, itemId: string): Promise<PlaylistDetail> {
      await findOwned(userId, playlistId);
      await withLock(playlistId, async () => {
        await db
          .delete(playlistItems)
          .where(and(eq(playlistItems.id, itemId), eq(playlistItems.playlistId, playlistId)));
        await touch(playlistId);
      });
      return detail(await findOwned(userId, playlistId));
    },

    async reorderItem(
      userId: string,
      playlistId: string,
      itemId: string,
      toIndex: number,
    ): Promise<PlaylistDetail> {
      await findOwned(userId, playlistId);
      await withLock(playlistId, async () => {
        const rows = await db
          .select({ id: playlistItems.id })
          .from(playlistItems)
          .where(eq(playlistItems.playlistId, playlistId))
          .orderBy(asc(playlistItems.position));
        const ids = rows.map((r) => r.id);
        const from = ids.indexOf(itemId);
        if (from === -1) throw new PlaylistError('playlist_not_found', 'Track not in playlist');
        ids.splice(from, 1);
        ids.splice(Math.min(toIndex, ids.length), 0, itemId);
        const cases = sql.join(
          ids.map((id, i) => sql`when ${id}::uuid then ${i + 1}::int`),
          sql` `,
        );
        await db
          .update(playlistItems)
          .set({ position: sql`case ${playlistItems.id} ${cases} end` })
          .where(and(eq(playlistItems.playlistId, playlistId), inArray(playlistItems.id, ids)));
        await touch(playlistId);
      });
      return detail(await findOwned(userId, playlistId));
    },

    async getShared(viewerId: string, slug: string): Promise<SharedPlaylist> {
      const row = await findViewable(viewerId, slug);
      const [owner] = await db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, row.ownerId));
      return {
        ...(await detail(row)),
        owner: { displayName: owner?.displayName ?? 'Someone' },
        isOwner: row.ownerId === viewerId,
      };
    },

    /** Copies a viewable playlist into the user's library. */
    async copyShared(userId: string, slug: string): Promise<PlaylistDetail> {
      const source = await findViewable(userId, slug);
      const items = await db
        .select({ videoId: playlistItems.videoId })
        .from(playlistItems)
        .where(eq(playlistItems.playlistId, source.id))
        .orderBy(asc(playlistItems.position));
      const copy = await createRow(userId, source.name);
      await append(
        copy.id,
        items.map((i) => i.videoId),
      );
      return detail(copy);
    },

    /** A new playlist holding the given videos, as for "save room history". */
    async createFromVideos(userId: string, name: string, videoIds: string[]): Promise<AddResult> {
      const ok = await storedPlayable(videoIds);
      if (ok.length === 0) throw new PlaylistError('nothing_to_import', 'There is nothing to save');
      const row = await createRow(userId, name);
      const { added } = await append(row.id, ok);
      return addResult(row, added, new Set(videoIds).size);
    },

    /** Imports a public YouTube playlist as a new playlist. */
    async importFromYouTube(userId: string, url: string, name?: string): Promise<AddResult> {
      if (!settings.get('features.playlistImport')) {
        throw new PlaylistError('import_disabled', 'Playlist import is turned off');
      }
      const listId = parsePlaylistId(url);
      if (!listId)
        throw new PlaylistError('invalid_playlist_url', 'That is not a YouTube playlist link');
      const max = Math.min(settings.get('limits.maxPlaylistImportItems'), MAX_PLAYLIST_ITEMS);
      let ids: string[];
      try {
        ids = await youtube.getPlaylistVideoIds(listId, max, userId);
      } catch (err) {
        if (err instanceof YouTubeError) {
          if (err.code === 'not_found') throw new PlaylistError('import_not_found', err.message);
          if (err.code === 'user_limit') throw new PlaylistError('rate_limited', err.message);
          throw new PlaylistError(
            'youtube_unavailable',
            'Could not reach YouTube, try again later',
          );
        }
        throw err;
      }
      const ok = await playable(ids, userId);
      if (ok.length === 0) {
        throw new PlaylistError('nothing_to_import', 'No playable videos in that playlist');
      }
      const row = await createRow(userId, name ?? 'Imported playlist');
      const { added } = await append(row.id, ok);
      return addResult(row, added, new Set(ids).size);
    },

    /** Video ids to queue, in order. Own playlists and public ones can be queued. */
    async videoIdsForQueue(userId: string, playlistId: string): Promise<string[]> {
      const [row] = await db.select().from(playlists).where(eq(playlists.id, playlistId));
      if (!row || (!row.isPublic && row.ownerId !== userId)) {
        throw new PlaylistError('playlist_not_found', 'Playlist not found');
      }
      const items = await db
        .select({ videoId: playlistItems.videoId })
        .from(playlistItems)
        .where(eq(playlistItems.playlistId, playlistId))
        .orderBy(asc(playlistItems.position));
      return items.map((i) => i.videoId);
    },
  };
}

export type PlaylistService = ReturnType<typeof createPlaylistService>;
