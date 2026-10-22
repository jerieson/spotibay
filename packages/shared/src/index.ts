import { z } from 'zod';

export * from './identity.js';
export * from './rooms.js';
export * from './settings.js';
export * from './socket-events.js';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  db: z.enum(['ok', 'error']).optional(),
  redis: z.enum(['ok', 'error']).optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
