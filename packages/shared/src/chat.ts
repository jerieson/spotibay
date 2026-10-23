import { z } from 'zod';
import { avatarSchema } from './identity.js';

/** Messages sent in `room:state`. */
export const CHAT_HISTORY_LIMIT = 50;
/** Reactions one user may send per window. */
export const REACTION_LIMIT = 10;
export const REACTION_WINDOW_SEC = 10;
/** The only emojis `chat:react` accepts. */
export const REACTION_EMOJIS = ['❤️', '🔥', '👏', '😂', '😮', '🎉', '👍', '🎶'] as const;

export const reactionEmojiSchema = z.enum(REACTION_EMOJIS);
export type ReactionEmoji = z.infer<typeof reactionEmojiSchema>;

export const chatBodySchema = z.string().trim().min(1);

export const chatAuthorSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  avatar: avatarSchema,
});

export const chatMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    id: z.string(),
    author: chatAuthorSchema,
    body: z.string(),
    createdAt: z.string(),
  }),
  z.object({
    kind: z.literal('system'),
    id: z.string(),
    body: z.string(),
    createdAt: z.string(),
  }),
]);
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatReactionSchema = z.object({
  /** Unique per reaction, so clients can key the floating animation. */
  id: z.string(),
  userId: z.string(),
  emoji: reactionEmojiSchema,
});
export type ChatReaction = z.infer<typeof chatReactionSchema>;
