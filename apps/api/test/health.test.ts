import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@listen/shared';
import { createApp } from '../src/app.js';

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(healthResponseSchema.parse(res.body)).toEqual({ status: 'ok' });
  });
});
