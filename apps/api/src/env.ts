import { z } from 'zod';

/** Compose passes unset variables as '', which means "not set" here. */
const unsetIfEmpty = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).default('postgres://spotibay:spotibay@localhost:5432/spotibay'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  RECOVERY_HMAC_SECRET: z.string().min(32, 'RECOVERY_HMAC_SECRET must be at least 32 characters'),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  /** Unset keeps the admin panel switched off. From: pnpm --filter api hash-password <password> */
  ADMIN_PASSWORD_HASH: unsetIfEmpty(z.string().min(1)),
  YOUTUBE_API_KEY: z.string().optional(),
  /** GIFs and stickers in chat (partner.klipy.com). Unset hides the picker. */
  KLIPY_API_KEY: unsetIfEmpty(z.string().min(1)),
  /** Odesli (song.link) key. Set, suggested songs are matched without a YouTube search. */
  ODESLI_API_KEY: unsetIfEmpty(z.string().min(1)),
  /** Last.fm key (last.fm/api). Set, "For you" and autoplay follow songs similar to the last one. */
  LASTFM_API_KEY: unsetIfEmpty(z.string().min(1)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  /** The public URL; when set, browser requests from any other origin are refused. */
  APP_URL: unsetIfEmpty(z.url()),
  /** The zone the admin dashboard counts days and hours in (an IANA name). */
  ANALYTICS_TIMEZONE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en-CA', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'ANALYTICS_TIMEZONE must be a time zone like Asia/Manila')
      .default('Asia/Manila'),
  ),
});

export const env = envSchema.parse(process.env);
