import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  CHAT_HISTORY_LIMIT,
  REACTION_LIMIT,
  REACTION_WINDOW_SEC,
  type Avatar,
  type ChatMessage,
  type ChatReaction,
  type ReactionEmoji,
  type SettingKey,
  type SettingsValues,
} from '@spotibay/shared';
import { hit } from '../lib/rate-limit.js';
import { maskFilteredWords } from '../lib/word-filter.js';
import type { ChatStore } from './chat-store.js';

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
  now?: () => number;
}

export function createChatService({ store, redis, settings, now = Date.now }: ChatServiceDeps) {
  const messageListeners = new Set<(roomId: string, message: ChatMessage) => void>();
  const reactionListeners = new Set<(roomId: string, reaction: ChatReaction) => void>();

  function emitMessage(roomId: string, message: ChatMessage) {
    for (const listener of messageListeners) listener(roomId, message);
  }

  async function send(roomId: string, author: ChatAuthor, rawBody: string): Promise<ChatMessage> {
    if (!settings.get('features.chat')) {
      throw new ChatError('feature_disabled', 'Chat is turned off');
    }
    const max = settings.get('limits.chatMessageMaxLength');
    if ([...rawBody].length > max) {
      throw new ChatError('invalid_payload', `Messages can be at most ${max} characters`);
    }
    const allowed = await hit(
      redis,
      `ratelimit:chat:${author.userId}`,
      settings.get('limits.chatMessagesPerMinute'),
      60,
    );
    if (!allowed) throw new ChatError('rate_limited', "You're sending messages too fast");

    const body = maskFilteredWords(rawBody, settings.get('moderation.wordFilter'));
    const row = await store.insert({ roomId, userId: author.userId, body });
    const message: ChatMessage = {
      kind: 'user',
      id: row.id,
      author,
      body,
      createdAt: row.createdAt.toISOString(),
    };
    emitMessage(roomId, message);
    return message;
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
    const allowed = await hit(redis, `ratelimit:react:${userId}`, REACTION_LIMIT, REACTION_WINDOW_SEC);
    // Reactions are cheap and noisy; dropping the excess beats nagging with an error per tap.
    if (!allowed) return;
    const reaction: ChatReaction = { id: randomUUID(), userId, emoji };
    for (const listener of reactionListeners) listener(roomId, reaction);
  }

  return {
    send,
    system,
    history,
    react,
    onMessage(listener: (roomId: string, message: ChatMessage) => void) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onReaction(listener: (roomId: string, reaction: ChatReaction) => void) {
      reactionListeners.add(listener);
      return () => reactionListeners.delete(listener);
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;
