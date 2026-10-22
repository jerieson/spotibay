import { z } from 'zod';

export * from './settings.js';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  db: z.enum(['ok', 'error']).optional(),
  redis: z.enum(['ok', 'error']).optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
