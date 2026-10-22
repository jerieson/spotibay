import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@spotibay/shared';
import { createApp } from '../src/app.js';

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(healthResponseSchema.parse(res.body)).toEqual({ status: 'ok' });
  });
});

describe('GET /api/health with dependency checks', () => {
  const ok = async () => 1;
  const fail = async () => {
    throw new Error('down');
  };

  it('reports db and redis ok', async () => {
    const res = await request(createApp({ db: ok, redis: ok })).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok', redis: 'ok' });
  });

  it('returns 503 when a dependency is down', async () => {
    const res = await request(createApp({ db: ok, redis: fail })).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', db: 'ok', redis: 'error' });
  });
});
