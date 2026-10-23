import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).default('postgres://spotibay:spotibay@localhost:5432/spotibay'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  RECOVERY_HMAC_SECRET: z.string().min(32, 'RECOVERY_HMAC_SECRET must be at least 32 characters'),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  /** Unset keeps the admin panel switched off. From: pnpm --filter api hash-password <password> */
  ADMIN_PASSWORD_HASH: z.string().min(1).optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
});

export const env = envSchema.parse(process.env);
