import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SocketError } from '@spotibay/shared';
import { createHarness, sleep, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ rateLimits: true });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.settings.set('limits.requestsPerMinute', 300, null);
  await h.settings.set('limits.expensiveRequestsPerMinute', 100, null);
  await h.settings.set('limits.socketEventsPerSecond', 30, null);
  await h.redis.flushdb();
});

describe('REST limits', () => {
  it('answers 429 with Retry-After once an address passes the general cap', async () => {
    await h.settings.set('limits.requestsPerMinute', 3, null);
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${h.baseUrl}/api/site`);
      statuses.push(res.status);
      retryAfter = res.headers.get('retry-after');
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(retryAfter).toBe('60');
  });

  it('caps account and room creation harder than plain reads', async () => {
    await h.settings.set('limits.expensiveRequestsPerMinute', 2, null);
    const first = await h.guest();
    await first.api('POST', '/rooms', { name: 'One' });
    // Two guest sessions plus a room already used two hits, so the next create is refused.
    const blocked = await first.api('POST', '/rooms', { name: 'Two' });
    expect(blocked.status).toBe(429);
    const read = await first.api('GET', '/rooms');
    expect(read.status).toBe(200);
  });

  it('applies a changed limit without a restart', async () => {
    await h.settings.set('limits.requestsPerMinute', 1, null);
    expect((await fetch(`${h.baseUrl}/api/site`)).status).toBe(200);
    expect((await fetch(`${h.baseUrl}/api/site`)).status).toBe(429);
    await h.settings.set('limits.requestsPerMinute', 50, null);
    expect((await fetch(`${h.baseUrl}/api/site`)).status).toBe(200);
  });

  it('leaves the health check alone', async () => {
    await h.settings.set('limits.requestsPerMinute', 1, null);
    for (let i = 0; i < 3; i++) expect((await fetch(`${h.baseUrl}/api/health`)).status).toBe(200);
  });
});

describe('socket limits', () => {
  it('drops events past the per-user cap and reports rate_limited', async () => {
    await h.settings.set('limits.socketEventsPerSecond', 1, null);
    const guest = await h.guest();
    const socket = await guest.socket();
    const errors: SocketError[] = [];
    socket.on('error', (e) => errors.push(e));
    // The window allows 1/s * 5 s = 5 events.
    for (let i = 0; i < 8; i++) socket.emit('time:ping', { t0: i });
    await sleep(300);
    expect(errors.length).toBe(3);
    expect(errors.every((e) => e.code === 'rate_limited')).toBe(true);
  });
});
