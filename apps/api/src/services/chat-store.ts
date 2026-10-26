import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  REPLY_EXCERPT_MAX,
  type Avatar,
  type ChatMedia,
  type ChatMention,
  type ChatMessage,
  type ChatReply,
  type MessageReaction,
  type ReactionEmoji,
} from '@spotibay/shared';
import type { Db } from '../db/client.js';
import { chatMessageReactions, chatMessages, users } from '../db/schema.js';

/** The part of a message a reply quotes. */
export interface ReplyTarget {
  id: string;
  authorName: string;
  body: string;
  media: ChatMedia | null;
  deleted: boolean;
}

export function toReply(target: ReplyTarget): ChatReply {
  if (target.deleted) {
    return { id: target.id, authorName: null, excerpt: '', media: null, deleted: true };
  }
  const chars = [...target.body];
  return {
    id: target.id,
    authorName: target.authorName,
    excerpt:
      chars.length > REPLY_EXCERPT_MAX
        ? `${chars.slice(0, REPLY_EXCERPT_MAX - 1).join('')}…`
        : target.body,
    media: target.media?.kind ?? null,
    deleted: false,
  };
}

export interface ChatStore {
  insert(input: {
    roomId: string;
    userId: string;
    body: string;
    replyToId: string | null;
    mentions: ChatMention[];
    media: ChatMedia | null;
  }): Promise<{ id: string; createdAt: Date }>;
  /** A message of this room, deleted or not; null when it belongs elsewhere or doesn't exist. */
  findInRoom(roomId: string, id: string): Promise<ReplyTarget | null>;
  /** The latest messages that have not been deleted, oldest first. */
  listRecent(roomId: string, limit: number): Promise<ChatMessage[]>;
  /** Adds the user's emoji to the message, or removes it if it was there. */
  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<void>;
  reactionsFor(messageIds: string[]): Promise<Map<string, MessageReaction[]>>;
}

export function createChatStore(db: Db): ChatStore {
  const parent = alias(chatMessages, 'parent');
  const parentAuthor = alias(users, 'parent_author');

  /** Emojis in the order someone first used them, each with its reactors in order. */
  async function reactionsFor(messageIds: string[]) {
    const byMessage = new Map<string, MessageReaction[]>();
    if (messageIds.length === 0) return byMessage;
    const rows = await db
      .select({
        messageId: chatMessageReactions.messageId,
        userId: chatMessageReactions.userId,
        emoji: chatMessageReactions.emoji,
      })
      .from(chatMessageReactions)
      .where(inArray(chatMessageReactions.messageId, messageIds))
      .orderBy(asc(chatMessageReactions.createdAt));
    for (const row of rows) {
      const list = byMessage.get(row.messageId) ?? [];
      const entry = list.find((r) => r.emoji === row.emoji);
      if (entry) entry.userIds.push(row.userId);
      else list.push({ emoji: row.emoji as ReactionEmoji, userIds: [row.userId] });
      byMessage.set(row.messageId, list);
    }
    return byMessage;
  }

  return {
    reactionsFor,
    async toggleReaction(messageId, userId, emoji) {
      const removed = await db
        .delete(chatMessageReactions)
        .where(
          and(
            eq(chatMessageReactions.messageId, messageId),
            eq(chatMessageReactions.userId, userId),
            eq(chatMessageReactions.emoji, emoji),
          ),
        )
        .returning({ emoji: chatMessageReactions.emoji });
      if (removed.length === 0) {
        await db
          .insert(chatMessageReactions)
          .values({ messageId, userId, emoji })
          .onConflictDoNothing();
      }
    },
    async insert(input) {
      const [row] = await db
        .insert(chatMessages)
        .values(input)
        .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });
      return row!;
    },
    async findInRoom(roomId, id) {
      const [row] = await db
        .select({
          id: chatMessages.id,
          authorName: users.displayName,
          body: chatMessages.body,
          media: chatMessages.media,
          deletedAt: chatMessages.deletedAt,
        })
        .from(chatMessages)
        .innerJoin(users, eq(users.id, chatMessages.userId))
        .where(and(eq(chatMessages.id, id), eq(chatMessages.roomId, roomId)));
      if (!row) return null;
      return {
        id: row.id,
        authorName: row.authorName,
        body: row.body,
        media: row.media ?? null,
        deleted: row.deletedAt !== null,
      };
    },
    async listRecent(roomId, limit) {
      const rows = await db
        .select({
          id: chatMessages.id,
          body: chatMessages.body,
          mentions: chatMessages.mentions,
          media: chatMessages.media,
          createdAt: chatMessages.createdAt,
          deletedAt: chatMessages.deletedAt,
          userId: users.id,
          displayName: users.displayName,
          avatar: users.avatar,
          parentId: parent.id,
          parentBody: parent.body,
          parentMedia: parent.media,
          parentDeletedAt: parent.deletedAt,
          parentAuthor: parentAuthor.displayName,
        })
        .from(chatMessages)
        .innerJoin(users, eq(users.id, chatMessages.userId))
        .leftJoin(parent, eq(parent.id, chatMessages.replyToId))
        .leftJoin(parentAuthor, eq(parentAuthor.id, parent.userId))
        .where(eq(chatMessages.roomId, roomId))
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit);
      const live = rows.filter((r) => r.deletedAt === null).reverse();
      const reactions = await reactionsFor(live.map((r) => r.id));
      return live.map((r) => ({
        kind: 'user' as const,
        id: r.id,
        author: { userId: r.userId, displayName: r.displayName, avatar: r.avatar as Avatar },
        body: r.body,
        createdAt: r.createdAt.toISOString(),
        mentions: r.mentions,
        media: r.media ?? null,
        reactions: reactions.get(r.id) ?? [],
        replyTo:
          r.parentId === null
            ? null
            : toReply({
                id: r.parentId,
                authorName: r.parentAuthor ?? '',
                body: r.parentBody ?? '',
                media: r.parentMedia ?? null,
                deleted: r.parentDeletedAt !== null,
              }),
      }));
    },
  };
}
