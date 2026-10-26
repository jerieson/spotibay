import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GifSearchResponse, SiteResponse } from '@spotibay/shared';
import { createGifService, isKlipyMediaUrl } from '../src/services/gifs.js';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.redis.flushdb();
  h.klipyItems.clear();
  h.klipyCalls.length = 0;
  h.klipy.status = null;
  h.klipyItems.set('party-cat-1', { kind: 'gif', title: 'Party cat' });
  h.klipyItems.set('dancing-dog-2', { kind: 'gif', title: 'Dancing dog' });
  h.klipyItems.set('cat-sticker-3', { kind: 'sticker', title: 'Cat sticker' });
  h.klipyItems.set('elsewhere-4', { kind: 'gif', title: 'Cat elsewhere', host: 'evil.example' });
  await h.settings.set('features.gifs', true, null);
  await h.settings.set('limits.gifSearchesPerMinute', 30, null);
  await h.settings.set('gifs.contentFilter', 'medium', null);
});

type Guest = Awaited<ReturnType<Harness['guest']>>;
const gifs = (g: Guest, query: string) =>
  g.api<GifSearchResponse & { error?: string }>('GET', `/gifs/search?${query}`);
const ids = (res: { body: GifSearchResponse }) => res.body.items.map((i) => i.id);

describe('GET /api/gifs/search', () => {
  it('requires a session and validates the query', async () => {
    expect((await fetch(`${h.baseUrl}/api/gifs/search`)).status).toBe(401);
    const g = await h.guest();
    expect((await gifs(g, 'kind=video')).status).toBe(400);
    expect((await gifs(g, `q=${'x'.repeat(101)}`)).status).toBe(400);
    expect((await gifs(g, 'page=99')).status).toBe(400);
  });

  it('searches GIFs or stickers, skipping ads and media from other hosts', async () => {
    const g = await h.guest();
    const res = await gifs(g, 'q=Cat');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(['party-cat-1']);
    expect(res.body.nextPage).toBeNull();
    expect(ids(await gifs(g, 'kind=sticker&q=cat'))).toEqual(['cat-sticker-3']);
    expect(h.klipyCalls[0]).toMatch(/^\/api\/v1\/klipy-test-key\/gifs\/search\?/);
    expect(h.klipyCalls[0]).toContain('content_filter=medium');
  });

  it('shows trending when the query is empty', async () => {
    const g = await h.guest();
    expect(ids(await gifs(g, ''))).toEqual(['party-cat-1', 'dancing-dog-2']);
    expect(h.klipyCalls[0]).toContain('/gifs/trending');
  });

  it('caches answers for everyone', async () => {
    await gifs(await h.guest(), 'q=cat');
    await gifs(await h.guest(), 'q=%20%20CAT%20');
    expect(h.klipyCalls).toHaveLength(1);
  });

  it('limits uncached searches per person', async () => {
    await h.settings.set('limits.gifSearchesPerMinute', 1, null);
    const g = await h.guest();
    expect((await gifs(g, 'q=cat')).status).toBe(200);
    expect((await gifs(g, 'q=cat')).status).toBe(200);
    const blocked = await gifs(g, 'q=dog');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('gifs_rate_limited');
  });

  it('reports the feature switch and provider trouble', async () => {
    const g = await h.guest();
    h.klipy.status = 500;
    const down = await gifs(g, 'q=cat');
    expect(down.status).toBe(503);
    expect(down.body.error).toBe('gifs_unavailable');
    await h.settings.set('features.gifs', false, null);
    const off = await gifs(g, 'q=cat');
    expect(off.status).toBe(403);
    expect(off.body.error).toBe('gifs_disabled');
  });

  it('tells the site whether GIFs can be used', async () => {
    const site = async () => (await (await fetch(`${h.baseUrl}/api/site`)).json()) as SiteResponse;
    expect((await site()).gifs).toBe(true);
    await h.settings.set('features.gifs', false, null);
    expect((await site()).gifs).toBe(false);
  });
});

describe('gif service', () => {
  it('is unavailable without a key', async () => {
    const service = createGifService({ redis: h.redis, settings: h.settings, apiKey: undefined });
    expect(service.available()).toBe(false);
    await expect(service.search('u', 'gif', 'cat', 1)).rejects.toMatchObject({
      code: 'gifs_unavailable',
    });
  });

  it('only trusts https media on klipy.com', () => {
    expect(isKlipyMediaUrl('https://static.klipy.com/a/b.webp')).toBe(true);
    expect(isKlipyMediaUrl('http://static.klipy.com/a/b.webp')).toBe(false);
    expect(isKlipyMediaUrl('https://klipy.com.evil.example/a.webp')).toBe(false);
    expect(isKlipyMediaUrl('not a url')).toBe(false);
  });
});
