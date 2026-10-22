import { z } from 'zod';

export const adjectives = [
  'Amber',
  'Bold',
  'Brisk',
  'Calm',
  'Clever',
  'Cosmic',
  'Cozy',
  'Crisp',
  'Dapper',
  'Eager',
  'Fuzzy',
  'Gentle',
  'Giddy',
  'Golden',
  'Groovy',
  'Happy',
  'Jazzy',
  'Jolly',
  'Keen',
  'Lucky',
  'Mellow',
  'Mighty',
  'Nimble',
  'Noble',
  'Peppy',
  'Plucky',
  'Quiet',
  'Rapid',
  'Rowdy',
  'Silky',
  'Sleepy',
  'Snappy',
  'Sunny',
  'Swift',
  'Tidy',
  'Velvet',
  'Vivid',
  'Witty',
  'Zany',
  'Zesty',
] as const;

export const animals = [
  'Badger',
  'Bat',
  'Bison',
  'Cobra',
  'Condor',
  'Coyote',
  'Crane',
  'Dingo',
  'Dolphin',
  'Eagle',
  'Falcon',
  'Ferret',
  'Finch',
  'Fox',
  'Gecko',
  'Heron',
  'Ibis',
  'Jackal',
  'Koala',
  'Lemur',
  'Lynx',
  'Manatee',
  'Marmot',
  'Moose',
  'Newt',
  'Ocelot',
  'Otter',
  'Owl',
  'Panda',
  'Parrot',
  'Puffin',
  'Quokka',
  'Raven',
  'Seal',
  'Sloth',
  'Stoat',
  'Tapir',
  'Toucan',
  'Walrus',
  'Wombat',
] as const;

export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 24;

export const SESSION_COOKIE = 'spotibay_session';
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 365;

export const avatarStyles = [
  'adventurer',
  'avataaars',
  'bigSmile',
  'bottts',
  'funEmoji',
  'lorelei',
  'notionists',
  'thumbs',
] as const;

export type AvatarStyle = (typeof avatarStyles)[number];

/** Background swatches (hex without `#`, as DiceBear expects). */
export const avatarBackgrounds = [
  'ceff00',
  'ffd5dc',
  'ffdfbf',
  'c0aede',
  'd1d4f9',
  'b6e3f4',
  'a8e6cf',
  'e5e5e5',
] as const;

export const displayNameSchema = z
  .string()
  .trim()
  .min(DISPLAY_NAME_MIN)
  .max(DISPLAY_NAME_MAX)
  .refine((v) => !/\p{C}/u.test(v), 'control characters are not allowed');

export const avatarSchema = z.object({
  style: z.enum(avatarStyles),
  seed: z.string().trim().min(1).max(64),
  options: z
    .object({
      backgroundColor: z
        .string()
        .regex(/^[0-9a-fA-F]{6}$/)
        .optional(),
    })
    .strict(),
});

export type Avatar = z.infer<typeof avatarSchema>;

export const userSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  avatar: avatarSchema,
  createdAt: z.string(),
});

export type User = z.infer<typeof userSchema>;

export const sessionResponseSchema = z.object({
  user: userSchema,
  /** Present only when the account was just created; never retrievable again. */
  recoveryCode: z.string().nullable(),
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const recoverBodySchema = z.object({ code: z.string().trim().min(1).max(64) });

export const recoveryCodeResponseSchema = z.object({ recoveryCode: z.string() });

export const meResponseSchema = z.object({ user: userSchema });

export const updateMeBodySchema = z
  .object({ displayName: displayNameSchema, avatar: avatarSchema })
  .partial()
  .refine((v) => v.displayName !== undefined || v.avatar !== undefined, 'nothing to update');

export type UpdateMeBody = z.infer<typeof updateMeBodySchema>;

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});
