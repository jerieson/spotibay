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

/** People one message can mention. */
export const MAX_MENTIONS = 10;
/** Characters of the original message shown in a reply's quote. */
export const REPLY_EXCERPT_MAX = 120;
/** Hard cap before the `limits.chatMessageMaxLength` setting is checked by the service. */
const MAX_RAW_BODY = 2000;

export const chatMediaKindSchema = z.enum(['gif', 'sticker']);
export type ChatMediaKind = z.infer<typeof chatMediaKindSchema>;

/** A GIF or sticker. Only the server builds these, from the provider's own data. */
export const chatMediaSchema = z.object({
  kind: chatMediaKindSchema,
  /** The provider's slug. */
  id: z.string(),
  title: z.string(),
  /** Shown in chat. */
  url: z.string(),
  /** Smaller rendition for the picker grid. */
  previewUrl: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type ChatMedia = z.infer<typeof chatMediaSchema>;

export const chatMediaIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/, 'Invalid media id');

export const chatMentionSchema = z.object({ userId: z.string(), displayName: z.string() });
export type ChatMention = z.infer<typeof chatMentionSchema>;

/** What a reply shows of the message it answers. */
export const chatReplySchema = z.object({
  id: z.string(),
  authorName: z.string().nullable(),
  excerpt: z.string(),
  media: chatMediaKindSchema.nullable(),
  /** The original was removed by a moderator. */
  deleted: z.boolean(),
});
export type ChatReply = z.infer<typeof chatReplySchema>;

/** `chat:send`. A message needs text or a GIF/sticker; the server fills in everything else. */
export const chatSendSchema = z
  .object({
    body: z.string().trim().max(MAX_RAW_BODY).default(''),
    replyToId: z.uuid().optional(),
    mentionIds: z.array(z.uuid()).max(MAX_MENTIONS).optional(),
    media: z.object({ kind: chatMediaKindSchema, id: chatMediaIdSchema }).optional(),
  })
  .refine((m) => m.body !== '' || m.media !== undefined, 'Message is empty');
export type ChatSend = z.infer<typeof chatSendSchema>;

/** Toggles allowed per user per window on chat messages. */
export const MESSAGE_REACTION_LIMIT = 20;
export const MESSAGE_REACTION_WINDOW_SEC = 10;

/** One emoji on a message and who added it, in the order they reacted. */
export const messageReactionSchema = z.object({
  emoji: reactionEmojiSchema,
  userIds: z.array(z.string()),
});
export type MessageReaction = z.infer<typeof messageReactionSchema>;

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
    replyTo: chatReplySchema.nullable(),
    mentions: z.array(chatMentionSchema),
    media: chatMediaSchema.nullable(),
    reactions: z.array(messageReactionSchema),
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
