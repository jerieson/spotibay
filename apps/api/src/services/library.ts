import { and, desc, eq, lt } from 'drizzle-orm';
import { HISTORY_PAGE_SIZE, type ListenHistoryResponse, type Track } from '@spotibay/shared';
import type { Db } from '../db/client.js';
import { likes, listenHistory, tracks } from '../db/schema.js';

/** Most liked songs returned in one list. */
const LIKES_LIMIT = 1000;

const trackColumns = {
  videoId: tracks.videoId,
  title: tracks.title,
  channelTitle: tracks.channelTitle,
  thumbnailUrl: tracks.thumbnailUrl,
  durationSec: tracks.durationSec,
};

export interface LibraryServiceDeps {
  db: Db;
}

/** Liked songs and a user's personal listening history. */
export function createLibraryService({ db }: LibraryServiceDeps) {
  return {
    /** Liked tracks, newest like first. */
    async listLikes(userId: string): Promise<Track[]> {
      return db
        .select(trackColumns)
        .from(likes)
        .innerJoin(tracks, eq(tracks.videoId, likes.videoId))
        .where(eq(likes.userId, userId))
        .orderBy(desc(likes.createdAt))
        .limit(LIKES_LIMIT);
    },

    /** Returns false when the track is unknown, so it can't be liked. */
    async like(userId: string, videoId: string): Promise<boolean> {
      const [track] = await db
        .select({ videoId: tracks.videoId })
        .from(tracks)
        .where(eq(tracks.videoId, videoId));
      if (!track) return false;
      await db.insert(likes).values({ userId, videoId }).onConflictDoNothing();
      return true;
    },

    async unlike(userId: string, videoId: string): Promise<void> {
      await db.delete(likes).where(and(eq(likes.userId, userId), eq(likes.videoId, videoId)));
    },

    /** The user's plays, newest first, a page at a time. */
    async history(userId: string, before?: number): Promise<ListenHistoryResponse> {
      const rows = await db
        .select({ id: listenHistory.id, playedAt: listenHistory.playedAt, ...trackColumns })
        .from(listenHistory)
        .innerJoin(tracks, eq(tracks.videoId, listenHistory.videoId))
        .where(
          and(
            eq(listenHistory.userId, userId),
            before === undefined ? undefined : lt(listenHistory.id, before),
          ),
        )
        .orderBy(desc(listenHistory.id))
        .limit(HISTORY_PAGE_SIZE + 1);
      const page = rows.slice(0, HISTORY_PAGE_SIZE);
      return {
        entries: page.map(({ id, playedAt, ...track }) => ({
          id,
          playedAt: playedAt.toISOString(),
          track,
        })),
        nextBefore: rows.length > HISTORY_PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
      };
    },
  };
}

export type LibraryService = ReturnType<typeof createLibraryService>;
