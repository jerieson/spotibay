import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { QueueItem } from '@spotibay/shared';
import type { Db } from '../db/client.js';
import { apiQuotaUsage, listenHistory, queueItems, tracks, users } from '../db/schema.js';
import type { QuotaStore, StoredTrack, TrackStore } from './youtube.js';

export type ActiveStatus = 'queued' | 'playing';
export type FinalStatus = 'played' | 'skipped' | 'removed';

export interface ActiveQueueItem {
  status: ActiveStatus;
  item: QueueItem;
}

export interface QueueStore {
  /** Appends to the end of the room's queue. */
  insert(input: { roomId: string; videoId: string; addedBy: string }): Promise<QueueItem | null>;
  /** Queued and playing items in play order. */
  listActive(roomId: string): Promise<ActiveQueueItem[]>;
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
      return rows.map((r) => ({ status: r.status as ActiveStatus, item: toItem(r) }));
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
      if (rows.length === 0) return;
      await db
        .insert(tracks)
        .values(rows)
        .onConflictDoUpdate({
          target: tracks.videoId,
          set: {
            title: sql`excluded.title`,
            channelTitle: sql`excluded.channel_title`,
            durationSec: sql`excluded.duration_sec`,
            thumbnailUrl: sql`excluded.thumbnail_url`,
            embeddable: sql`excluded.embeddable`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
    },
    async markUnembeddable(videoId) {
      await db.update(tracks).set({ embeddable: false }).where(eq(tracks.videoId, videoId));
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
