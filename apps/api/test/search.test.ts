import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SearchResponse } from '@spotibay/shared';
import { apiQuotaUsage } from '../src/db/schema.js';
import { quotaDate } from '../src/services/youtube.js';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const C = 'ccccccccccc';

beforeEach(async () => {
  await h.redis.flushdb();
  await h.db.execute('truncate table tracks, api_quota_usage cascade');
  h.videos.clear();
  h.searchResults.clear();
  h.searchCalls.length = 0;
  h.youtubeCalls.length = 0;
  h.videos.set(A, { title: 'Alpha', durationSec: 200 });
  h.videos.set(B, { title: 'Bravo', durationSec: 180 });
  h.videos.set(C, { title: 'Hidden', durationSec: 100, embeddable: false });
  h.searchResults.set('lo-fi beats', [A, B, C]);
  await h.settings.set('features.search', true, null);
  await h.settings.set('limits.searchesPerMinute', 5, null);
  await h.settings.set('search.dailySearchCallBudget', 95, null);
});

const search = (g: Awaited<ReturnType<Harness['guest']>>, q: string) =>
  g.api<SearchResponse & { error?: string }>('GET', `/search?q=${encodeURIComponent(q)}`);

describe('GET /api/search', () => {
  it('requires a session and a query', async () => {
    const res = await fetch(`${h.baseUrl}/api/search?q=x`);
    expect(res.status).toBe(401);
    const g = await h.guest();
    expect((await g.api('GET', '/search')).status).toBe(400);
    expect((await g.api('GET', `/search?q=${'x'.repeat(101)}`)).status).toBe(400);
  });

  it('returns playable tracks with durations and stores them', async () => {
    const g = await h.guest();
    const res = await search(g, 'lo-fi beats');
    expect(res.status).toBe(200);
    expect(res.body.results.map((t) => t.videoId)).toEqual([A, B]);
    expect(res.body.results[0]).toMatchObject({ title: 'Alpha', durationSec: 200 });
    const rows = await h.db.execute('select video_id from tracks');
    expect(rows.rowCount).toBe(3);
  });

  it('answers a repeated query from the cache without calling YouTube', async () => {
    const g = await h.guest();
    await search(g, 'lo-fi beats');
    const other = await h.guest();
    const again = await search(other, '  LO-FI   Beats ');
    expect(again.status).toBe(200);
    expect(again.body.results).toHaveLength(2);
    expect(h.searchCalls).toEqual(['lo-fi beats']);
  });

  it('records quota units per Pacific day', async () => {
    const g = await h.guest();
    await search(g, 'lo-fi beats');
    const [row] = await h.db
      .select()
      .from(apiQuotaUsage)
      .where(eq(apiQuotaUsage.date, quotaDate(new Date())));
    // search.list (100) + videos.list (1)
    expect(row).toMatchObject({ units: 101, searchCalls: 1 });
  });

  it('limits uncached searches per minute but still serves cached queries', async () => {
    await h.settings.set('limits.searchesPerMinute', 2, null);
    const g = await h.guest();
    h.searchResults.set('second', [A]);
    h.searchResults.set('third', [B]);
    expect((await search(g, 'lo-fi beats')).status).toBe(200);
    // Cache hits are free.
    expect((await search(g, 'lo-fi beats')).status).toBe(200);
    expect((await search(g, 'second')).status).toBe(200);
    const blocked = await search(g, 'third');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('search_rate_limited');
    expect(h.searchCalls).toEqual(['lo-fi beats', 'second']);
    expect((await search(g, 'second')).status).toBe(200);
    // Another person has their own allowance.
    expect((await search(await h.guest(), 'third')).status).toBe(200);
  });

  it('has no daily cap per person', async () => {
    const g = await h.guest();
    for (let i = 0; i < 12; i++) {
      h.searchResults.set(`song ${i}`, [A]);
      // Each minute's allowance is spent; start the next window.
      if (i % 5 === 0) await h.redis.del(`ratelimit:search:${g.user.id}`);
      expect((await search(g, `song ${i}`)).status).toBe(200);
    }
    expect(h.searchCalls).toHaveLength(12);
  });

  it('stops everyone once the global daily budget is spent', async () => {
    await h.settings.set('search.dailySearchCallBudget', 1, null);
    const a = await h.guest();
    const b = await h.guest();
    h.searchResults.set('another', [A]);
    expect((await search(a, 'lo-fi beats')).status).toBe(200);
    const blocked = await search(b, 'another');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('search_budget_exhausted');
    expect(h.searchCalls).toHaveLength(1);
  });

  it('is refused when the search feature is off', async () => {
    await h.settings.set('features.search', false, null);
    const g = await h.guest();
    const res = await search(g, 'lo-fi beats');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('search_disabled');
    expect(h.searchCalls).toHaveLength(0);
  });
});
