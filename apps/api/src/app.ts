import express from 'express';
import type { HealthResponse } from '@spotibay/shared';

export interface HealthChecks {
  db: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}

async function probe(check: () => Promise<unknown>): Promise<'ok' | 'error'> {
  try {
    await check();
    return 'ok';
  } catch {
    return 'error';
  }
}

export function createApp(checks?: HealthChecks) {
  const app = express();

  app.get('/api/health', async (_req, res) => {
    const body: HealthResponse = { status: 'ok' };
    if (checks) {
      const [db, redis] = await Promise.all([probe(checks.db), probe(checks.redis)]);
      body.db = db;
      body.redis = redis;
      if (db === 'error' || redis === 'error') body.status = 'error';
    }
    res.status(body.status === 'ok' ? 200 : 503).json(body);
  });

  return app;
}
