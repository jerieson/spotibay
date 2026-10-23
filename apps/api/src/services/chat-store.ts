import { desc, eq } from 'drizzle-orm';
import type { Avatar, ChatMessage } from '@spotibay/shared';
import type { Db } from '../db/client.js';
import { chatMessages, users } from '../db/schema.js';

export interface ChatStore {
  insert(input: { roomId: string; userId: string; body: string }): Promise<{
    id: string;
    createdAt: Date;
  }>;
  /** The latest messages that have not been deleted, oldest first. */
  listRecent(roomId: string, limit: number): Promise<ChatMessage[]>;
}

export function createChatStore(db: Db): ChatStore {
  return {
    async insert(input) {
      const [row] = await db
        .insert(chatMessages)
        .values(input)
        .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });
      return row!;
    },
    async listRecent(roomId, limit) {
      const rows = await db
        .select({
          id: chatMessages.id,
          body: chatMessages.body,
          createdAt: chatMessages.createdAt,
          deletedAt: chatMessages.deletedAt,
          userId: users.id,
          displayName: users.displayName,
          avatar: users.avatar,
        })
        .from(chatMessages)
        .innerJoin(users, eq(users.id, chatMessages.userId))
        .where(eq(chatMessages.roomId, roomId))
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit);
      return rows
        .filter((r) => r.deletedAt === null)
        .reverse()
        .map((r) => ({
          kind: 'user' as const,
          id: r.id,
          author: { userId: r.userId, displayName: r.displayName, avatar: r.avatar as Avatar },
          body: r.body,
          createdAt: r.createdAt.toISOString(),
        }));
    },
  };
}
