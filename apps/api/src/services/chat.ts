import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  CHAT_HISTORY_LIMIT,
  REACTION_LIMIT,
  REACTION_WINDOW_SEC,
  MAX_MENTIONS,
  MESSAGE_REACTION_LIMIT,
  MESSAGE_REACTION_WINDOW_SEC,
  type Avatar,
  type ChatMedia,
  type ChatMention,
  type ChatMessage,
  type ChatReaction,
  type ChatReply,
  type ChatSend,
  type MessageReaction,
  type ReactionEmoji,
  type SettingKey,
  type SettingsValues,
} from '@spotibay/shared';
import { hit } from '../lib/rate-limit.js';
import { maskFilteredWords } from '../lib/word-filter.js';
import { toReply, type ChatStore } from './chat-store.js';
import { GifError, type GifService } from './gifs.js';

export type ChatErrorCode = 'invalid_payload' | 'rate_limited' | 'feature_disabled';

export class ChatError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

export interface ChatAuthor {
  userId: string;
  displayName: string;
  avatar: Avatar;
}

export interface ChatServiceDeps {
  store: ChatStore;
  redis: Redis;
  settings: { get<K extends SettingKey>(key: K): SettingsValues[K] };
  gifs: Pick<GifService, 'resolve'>;
  /** Who is in the room right now; only they can be mentioned. */
  members: (roomId: string) => Promise<{ userId: string; displayName: string }[]>;
  now?: () => number;
}

export function createChatService({
  store,
  redis,
  settings,
  gifs,
  members,
  now = Date.now,
}: ChatServiceDeps) {
  const messageListeners = new Set<(roomId: string, message: ChatMessage) => void>();
  const reactionListeners = new Set<(roomId: string, reaction: ChatReaction) => void>();
  const deletedListeners = new Set<(roomId: string, messageId: string) => void>();
  const messageReactionListeners = new Set<
    (roomId: string, messageId: string, reactions: MessageReaction[]) => void
  >();

  function emitMessage(roomId: string, message: ChatMessage) {
    for (const listener of messageListeners) listener(roomId, message);
  }

  /** Mentions the body really contains, of people who are in the room. */
  async function resolveMentions(roomId: string, body: string, ids: string[]) {
    if (ids.length === 0 || body === '') return [];
    const wanted = new Set(ids);
    const mentions: ChatMention[] = [];
    for (const m of await members(roomId)) {
      if (wanted.has(m.userId) && body.includes(`@${m.displayName}`)) {
        mentions.push({ userId: m.userId, displayName: m.displayName });
      }
    }
    return mentions.slice(0, MAX_MENTIONS);
  }

  async function resolveReply(roomId: string, id: string | undefined): Promise<ChatReply | null> {
    if (!id) return null;
    const target = await store.findInRoom(roomId, id);
    if (!target || target.deleted) {
      throw new ChatError('invalid_payload', 'That message is no longer available');
    }
    return toReply(target);
  }

  async function resolveMedia(input: ChatSend['media']): Promise<ChatMedia | null> {
    if (!input) return null;
    try {
      return await gifs.resolve(input.kind, input.id);
    } catch (err) {
      if (!(err instanceof GifError)) throw err;
      if (err.code === 'gifs_disabled') throw new ChatError('feature_disabled', err.message);
      throw new ChatError('invalid_payload', err.message);
    }
  }

  async function send(roomId: string, author: ChatAuthor, input: ChatSend): Promise<ChatMessage> {
    if (!settings.get('features.chat')) {
      throw new ChatError('feature_disabled', 'Chat is turned off');
    }
    const max = settings.get('limits.chatMessageMaxLength');
    if ([...input.body].length > max) {
      throw new ChatError('invalid_payload', `Messages can be at most ${max} characters`);
    }
    const allowed = await hit(
      redis,
      `ratelimit:chat:${author.userId}`,
      settings.get('limits.chatMessagesPerMinute'),
      60,
    );
    if (!allowed) throw new ChatError('rate_limited', "You're sending messages too fast");

    const [replyTo, media, mentions] = await Promise.all([
      resolveReply(roomId, input.replyToId),
      resolveMedia(input.media),
      // Matched before masking, so a filtered word can't hide a name.
      resolveMentions(roomId, input.body, input.mentionIds ?? []),
    ]);
    const body = maskFilteredWords(input.body, settings.get('moderation.wordFilter'));
    const row = await store.insert({
      roomId,
      userId: author.userId,
      body,
      replyToId: replyTo?.id ?? null,
      mentions,
      media,
    });
    const message: ChatMessage = {
      kind: 'user',
      id: row.id,
      author,
      body,
      createdAt: row.createdAt.toISOString(),
      replyTo,
      mentions,
      media,
      reactions: [],
    };
    emitMessage(roomId, message);
    return message;
  }

  /** Adds or takes back an emoji on a message, then tells the room the message's new reactions. */
  async function reactToMessage(
    roomId: string,
    userId: string,
    messageId: string,
    emoji: ReactionEmoji,
  ): Promise<void> {
    if (!settings.get('features.chat')) {
      throw new ChatError('feature_disabled', 'Chat is turned off');
    }
    const allowed = await hit(
      redis,
      `ratelimit:msgreact:${userId}`,
      MESSAGE_REACTION_LIMIT,
      MESSAGE_REACTION_WINDOW_SEC,
    );
    if (!allowed) throw new ChatError('rate_limited', "You're reacting too fast");
    const target = await store.findInRoom(roomId, messageId);
    if (!target || target.deleted) {
      throw new ChatError('invalid_payload', 'That message is no longer available');
    }
    await store.toggleReaction(messageId, userId, emoji);
    const reactions = (await store.reactionsFor([messageId])).get(messageId) ?? [];
    for (const listener of messageReactionListeners) listener(roomId, messageId, reactions);
  }

  /** Joins, leaves, track changes. Shown live only, not stored. */
  function system(roomId: string, body: string): void {
    if (!settings.get('features.chat')) return;
    emitMessage(roomId, {
      kind: 'system',
      id: randomUUID(),
      body,
      createdAt: new Date(now()).toISOString(),
    });
  }

  async function history(roomId: string): Promise<ChatMessage[]> {
    if (!settings.get('features.chat')) return [];
    return store.listRecent(roomId, CHAT_HISTORY_LIMIT);
  }

  async function react(roomId: string, userId: string, emoji: ReactionEmoji): Promise<void> {
    if (!settings.get('features.reactions')) {
      throw new ChatError('feature_disabled', 'Reactions are turned off');
    }
    const allowed = await hit(
      redis,
      `ratelimit:react:${userId}`,
      REACTION_LIMIT,
      REACTION_WINDOW_SEC,
    );
    // Reactions are cheap and noisy; dropping the excess beats nagging with an error per tap.
    if (!allowed) return;
    const reaction: ChatReaction = { id: randomUUID(), userId, emoji };
    for (const listener of reactionListeners) listener(roomId, reaction);
  }

  /** Tells the room a message was removed by a moderator. */
  function announceDeleted(roomId: string, messageId: string): void {
    for (const listener of deletedListeners) listener(roomId, messageId);
  }

  return {
    send,
    reactToMessage,
    announceDeleted,
    system,
    history,
    react,
    onMessage(listener: (roomId: string, message: ChatMessage) => void) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onDeleted(listener: (roomId: string, messageId: string) => void) {
      deletedListeners.add(listener);
      return () => deletedListeners.delete(listener);
    },
    onMessageReactions(
      listener: (roomId: string, messageId: string, reactions: MessageReaction[]) => void,
    ) {
      messageReactionListeners.add(listener);
      return () => messageReactionListeners.delete(listener);
    },
    onReaction(listener: (roomId: string, reaction: ChatReaction) => void) {
      reactionListeners.add(listener);
      return () => reactionListeners.delete(listener);
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;
