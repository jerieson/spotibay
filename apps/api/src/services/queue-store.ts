import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { HistoryEntry, QueueItem, VoteValue } from '@spotibay/shared';
import type { Db } from '../db/client.js';
import {
  apiQuotaUsage,
  catalogMatches,
  listenHistory,
  queueItems,
  queueVotes,
  tracks,
  users,
} from '../db/schema.js';
import type { CatalogMatchStore } from './search.js';
import type { QuotaStore, StoredTrack, TrackStore } from './youtube.js';

export type ActiveStatus = 'queued' | 'playing';
export type FinalStatus = 'played' | 'skipped' | 'removed';

export interface ActiveQueueItem {
  status: ActiveStatus;
  /** Base order; see `orderQueue`. */
  position: number;
  item: QueueItem;
}

export interface QueueStore {
  /** Appends to the end of the room's queue. */
  insert(input: { roomId: string; videoId: string; addedBy: string }): Promise<QueueItem | null>;
  /** Queued and playing items in play order. */
  listActive(roomId: string): Promise<ActiveQueueItem[]>;
  /** Sets or (with 0) clears a user's vote on an item. */
  setVote(queueItemId: string, userId: string, value: VoteValue | 0): Promise<void>;
  /** Rewrites the base order of the room's queued items to match `orderedIds`. */
  setPositions(roomId: string, orderedIds: string[]): Promise<void>;
  /** Most recently played items first, one entry per video. */
  listHistory(roomId: string, limit: number): Promise<HistoryEntry[]>;
  markPlaying(id: string, at: Date): Promise<void>;
  finish(id: string, status: FinalStatus, at: Date): Promise<void>;
  recordHistory(input: {
    roomId: string;
    videoId: string;
    userIds: string[];
    playedAt: Date;
  }): Promise<void>;
}

export function createQueueStore(db: Db): QueueStore {
  const itemColumns = {
    id: queueItems.id,
    status: queueItems.status,
    position: queueItems.position,
    endedAt: queueItems.endedAt,
    videoId: tracks.videoId,
    title: tracks.title,
    channelTitle: tracks.channelTitle,
    thumbnailUrl: tracks.thumbnailUrl,
    durationSec: tracks.durationSec,
    userId: users.id,
    displayName: users.displayName,
    avatar: users.avatar,
  };
  type Joined = {
    id: string;
    status: string;
    position: number;
    endedAt: Date | null;
    videoId: string;
    title: string;
    channelTitle: string;
    thumbnailUrl: string;
    durationSec: number;
    userId: string;
    displayName: string;
    avatar: QueueItem['addedBy']['avatar'];
  };
  const toItem = (r: Joined): QueueItem => ({
    id: r.id,
    track: {
      videoId: r.videoId,
      title: r.title,
      channelTitle: r.channelTitle,
      thumbnailUrl: r.thumbnailUrl,
      durationSec: r.durationSec,
    },
    addedBy: { userId: r.userId, displayName: r.displayName, avatar: r.avatar },
    votes: {},
  });
  const selectJoined = () =>
    db
      .select(itemColumns)
      .from(queueItems)
      .innerJoin(tracks, eq(tracks.videoId, queueItems.videoId))
      .innerJoin(users, eq(users.id, queueItems.addedBy));

  return {
    async insert({ roomId, videoId, addedBy }) {
      const [row] = await db
        .insert(queueItems)
        .values({
          roomId,
          videoId,
          addedBy,
          position: sql`(select coalesce(max(position), 0) + 1 from queue_items where room_id = ${roomId})`,
        })
        .returning({ id: queueItems.id });
      if (!row) return null;
      const [joined] = await selectJoined().where(eq(queueItems.id, row.id));
      return joined ? toItem(joined) : null;
    },
    async listActive(roomId) {
      const rows = await selectJoined()
        .where(
          and(eq(queueItems.roomId, roomId), inArray(queueItems.status, ['queued', 'playing'])),
        )
        .orderBy(asc(queueItems.position));
      const votes = new Map<string, QueueItem['votes']>();
      if (rows.length > 0) {
        const voteRows = await db
          .select()
          .from(queueVotes)
          .where(
            inArray(
              queueVotes.queueItemId,
              rows.map((r) => r.id),
            ),
          );
        for (const v of voteRows) {
          const forItem = votes.get(v.queueItemId) ?? {};
          forItem[v.userId] = v.value === 1 ? 1 : -1;
          votes.set(v.queueItemId, forItem);
        }
      }
      return rows.map((r) => ({
        status: r.status as ActiveStatus,
        position: r.position,
        item: { ...toItem(r), votes: votes.get(r.id) ?? {} },
      }));
    },
    async setVote(queueItemId, userId, value) {
      if (value === 0) {
        await db
          .delete(queueVotes)
          .where(and(eq(queueVotes.queueItemId, queueItemId), eq(queueVotes.userId, userId)));
        return;
      }
      await db
        .insert(queueVotes)
        .values({ queueItemId, userId, value })
        .onConflictDoUpdate({
          target: [queueVotes.queueItemId, queueVotes.userId],
          set: { value },
        });
    },
    async setPositions(roomId, orderedIds) {
      if (orderedIds.length === 0) return;
      const cases = sql.join(
        orderedIds.map((id, i) => sql`when ${id}::uuid then ${i + 1}::int`),
        sql` `,
      );
      await db
        .update(queueItems)
        .set({ position: sql`case ${queueItems.id} ${cases} end` })
        .where(
          and(
            eq(queueItems.roomId, roomId),
            eq(queueItems.status, 'queued'),
            inArray(queueItems.id, orderedIds),
          ),
        );
    },
    async listHistory(roomId, limit) {
      const rows = await selectJoined()
        .where(and(eq(queueItems.roomId, roomId), eq(queueItems.status, 'played')))
        .orderBy(desc(queueItems.endedAt), desc(queueItems.position))
        .limit(limit * 4);
      const seen = new Set<string>();
      const entries: HistoryEntry[] = [];
      for (const r of rows) {
        if (seen.has(r.videoId)) continue;
        seen.add(r.videoId);
        const { id, track, addedBy } = toItem(r);
        entries.push({ id, track, addedBy, playedAt: (r.endedAt ?? new Date(0)).toISOString() });
        if (entries.length === limit) break;
      }
      return entries;
    },
    async markPlaying(id, at) {
      await db
        .update(queueItems)
        .set({ status: 'playing', startedAt: at })
        .where(eq(queueItems.id, id));
    },
    async finish(id, status, at) {
      await db.update(queueItems).set({ status, endedAt: at }).where(eq(queueItems.id, id));
    },
    async recordHistory({ roomId, videoId, userIds, playedAt }) {
      if (userIds.length === 0) return;
      await db
        .insert(listenHistory)
        .values(userIds.map((userId) => ({ userId, videoId, roomId, playedAt })));
    },
  };
}

export function createTrackStore(db: Db): TrackStore {
  return {
    async findMany(videoIds) {
      if (videoIds.length === 0) return [];
      return db.select().from(tracks).where(inArray(tracks.videoId, videoIds));
    },
    async upsertMany(rows: StoredTrack[]) {
      if (rows.length === 0) return [];
      // Catalog metadata is cleaner than YouTube's, so a refresh only replaces it on plain tracks.
      const keep = (column: string) =>
        sql.raw(
          `case when tracks.catalog_id is null then excluded.${column} else tracks.${column} end`,
        );
      return db
        .insert(tracks)
        .values(rows)
        .onConflictDoUpdate({
          target: tracks.videoId,
          set: {
            title: keep('title'),
            channelTitle: keep('channel_title'),
            durationSec: sql`excluded.duration_sec`,
            thumbnailUrl: keep('thumbnail_url'),
            embeddable: sql`excluded.embeddable`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        })
        .returning();
    },
  };
}

export function createCatalogMatchStore(db: Db): CatalogMatchStore {
  return {
    async find(catalogId) {
      const [row] = await db
        .select({ videoId: catalogMatches.videoId })
        .from(catalogMatches)
        .where(eq(catalogMatches.catalogId, catalogId));
      return row?.videoId ?? null;
    },
    async save(song, videoId) {
      await db.transaction(async (tx) => {
        await tx
          .insert(catalogMatches)
          .values({ catalogId: song.id, videoId })
          .onConflictDoUpdate({ target: catalogMatches.catalogId, set: { videoId } });
        // The first song matched to a video names it; later ones (say, the album cut) don't rename it.
        await tx
          .update(tracks)
          .set({
            title: song.title,
            channelTitle: song.artist,
            ...(song.artworkUrl ? { thumbnailUrl: song.artworkUrl } : {}),
            catalogId: song.id,
          })
          .where(and(eq(tracks.videoId, videoId), sql`${tracks.catalogId} is null`));
      });
    },
  };
}

export function createQuotaStore(db: Db): QuotaStore {
  return {
    async add(date, units, searchCalls) {
      await db
        .insert(apiQuotaUsage)
        .values({ date, units, searchCalls })
        .onConflictDoUpdate({
          target: apiQuotaUsage.date,
          set: {
            units: sql`${apiQuotaUsage.units} + ${units}`,
            searchCalls: sql`${apiQuotaUsage.searchCalls} + ${searchCalls}`,
          },
        });
    },
    async get(date) {
      const [row] = await db.select().from(apiQuotaUsage).where(eq(apiQuotaUsage.date, date));
      return { units: row?.units ?? 0, searchCalls: row?.searchCalls ?? 0 };
    },
  };
}
