import express from 'express';
import type { HealthResponse } from '@listen/shared';

export function createApp() {
  const app = express();

  app.get('/api/health', (_req, res) => {
    const body: HealthResponse = { status: 'ok' };
    res.json(body);
  });

  return app;
}
