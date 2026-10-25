import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ResolveResponse, SuggestResponse, Track } from '@spotibay/shared';
import { pickMatch } from '../src/services/catalog.js';
import { createHarness, type Harness } from './helpers/harness.js';

const track = (over: Partial<Track>): Track => ({
  videoId: 'v'.repeat(11),
  title: 'Blinding Lights',
  channelTitle: 'The Weeknd - Topic',
  thumbnailUrl: 'https://i.ytimg.com/x.jpg',
  durationSec: 200,
  ...over,
});

describe('pickMatch', () => {
  const song = { title: 'Blinding Lights', artist: 'The Weeknd', durationSec: 200 };

  it('prefers the Topic upload, then the artist channel, over others', () => {
    const topic = track({ videoId: 'topic000000' });
    const vevo = track({
      videoId: 'vevo0000000',
      title: 'The Weeknd - Blinding Lights (Official Video)',
      channelTitle: 'TheWeekndVEVO',
      durationSec: 212,
    });
    const fan = track({
      videoId: 'fan00000000',
      title: 'The Weeknd - Blinding Lights lyrics',
      channelTitle: 'Lyric Vibes',
    });
    expect(pickMatch(song, [fan, vevo, topic])).toBe(topic);
    expect(pickMatch(song, [fan, vevo])).toBe(vevo);
    expect(pickMatch(song, [fan])).toBe(fan);
  });

  it('skips other recordings, other artists and wrong lengths', () => {
    expect(
      pickMatch(song, [
        track({ title: 'Blinding Lights (Live at the Super Bowl)', channelTitle: 'The Weeknd' }),
        track({ title: 'Blinding Lights - Piano Cover', channelTitle: 'The Weeknd fans' }),
        track({ title: 'Blinding Lights sped up', channelTitle: 'The Weeknd - Topic' }),
        track({ title: 'Blinding Lights', channelTitle: 'Someone Else' }),
        track({ title: 'Blinding Lights', durationSec: 260 }),
        track({ title: 'Save Your Tears' }),
      ]),
    ).toBeNull();
  });

  it('accepts a variant the catalog song itself is', () => {
    const live = track({ title: 'Blinding Lights (Live)', channelTitle: 'The Weeknd - Topic' });
    expect(pickMatch({ ...song, title: 'Blinding Lights (Live)' }, [live])).toBe(live);
  });

  it('ignores accents, case and feat. suffixes', () => {
    const t = track({ title: 'Despacito', channelTitle: 'Luis Fonsi - Topic', durationSec: 229 });
    expect(
      pickMatch(
        { title: 'Despacito (feat. Daddy Yankee)', artist: 'Luis Fonsi', durationSec: 228 },
        [t],
      ),
    ).toBe(t);
    const accented = track({ title: 'BEYONCÉ - Halo', channelTitle: 'Beyoncé', durationSec: 261 });
    expect(pickMatch({ title: 'Halo', artist: 'Beyonce', durationSec: 261 }, [accented])).toBe(
      accented,
    );
  });
});

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const TOPIC = 'topicvideo1';
const LIVE = 'livevideo01';

beforeEach(async () => {
  await h.redis.flushdb();
  await h.db.execute('truncate table tracks, api_quota_usage cascade');
  for (const m of [h.videos, h.searchResults, h.catalogSongs, h.catalogSearch]) m.clear();
  h.searchCalls.length = 0;
  h.youtubeCalls.length = 0;
  h.catalogCalls.length = 0;
  h.deezer.errorCode = null;
  h.catalogSongs.set('908604612', {
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    album: 'After Hours',
    durationSec: 200,
  });
  h.catalogSongs.set('42', { title: 'Obscure Song', artist: 'Nobody Knows', durationSec: 150 });
  h.catalogSearch.set('blinding', ['908604612']);
  h.videos.set(LIVE, {
    title: 'The Weeknd - Blinding Lights (Live)',
    channelTitle: 'The Weeknd',
    durationSec: 215,
  });
  h.videos.set(TOPIC, {
    title: 'Blinding Lights',
    channelTitle: 'The Weeknd - Topic',
    durationSec: 201,
  });
  h.searchResults.set('the weeknd blinding lights', [LIVE, TOPIC]);
  h.videos.set('someone0000', { title: 'Unrelated', durationSec: 150 });
  h.searchResults.set('nobody knows obscure song', ['someone0000']);
  await h.settings.set('features.catalogSearch', true, null);
  await h.settings.set('features.search', true, null);
  await h.settings.set('limits.searchesPerUserPerDay', 10, null);
  await h.settings.set('search.dailySearchCallBudget', 95, null);
});

type Guest = Awaited<ReturnType<Harness['guest']>>;
const suggest = (g: Guest, q: string) =>
  g.api<SuggestResponse & { error?: string }>('GET', `/search/suggest?q=${encodeURIComponent(q)}`);
const resolve = (g: Guest, catalogId: string) =>
  g.api<ResolveResponse & { error?: string }>('POST', '/search/resolve', { catalogId });

describe('GET /api/search/suggest', () => {
  it('requires a session and a query', async () => {
    expect((await fetch(`${h.baseUrl}/api/search/suggest?q=bl`)).status).toBe(401);
    const g = await h.guest();
    expect((await g.api('GET', '/search/suggest')).status).toBe(400);
  });

  it('returns catalog songs with artwork, without touching YouTube', async () => {
    const g = await h.guest();
    const res = await suggest(g, '  Blinding ');
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([
      {
        id: '908604612',
        title: 'Blinding Lights',
        artist: 'The Weeknd',
        album: 'After Hours',
        artworkUrl: 'https://cdn-images.dzcdn.net/images/cover/908604612/250x250.jpg',
        durationSec: 200,
      },
    ]);
    expect(h.searchCalls).toHaveLength(0);
    expect(h.youtubeCalls).toHaveLength(0);
  });

  it('caches answers and skips one-letter queries', async () => {
    const g = await h.guest();
    await suggest(g, 'blinding');
    await suggest(g, 'BLINDING');
    expect((await suggest(g, 'b')).body.suggestions).toEqual([]);
    expect(h.catalogCalls).toHaveLength(1);
  });

  it('reports Deezer trouble and the feature switch', async () => {
    const g = await h.guest();
    h.deezer.errorCode = 4;
    const busy = await suggest(g, 'blinding');
    expect(busy.status).toBe(503);
    expect(busy.body.error).toBe('catalog_unavailable');
    await h.settings.set('features.catalogSearch', false, null);
    const off = await suggest(g, 'blinding');
    expect(off.status).toBe(403);
    expect(off.body.error).toBe('catalog_disabled');
  });
});

describe('POST /api/search/resolve', () => {
  it('validates the catalog id', async () => {
    const g = await h.guest();
    expect((await g.api('POST', '/search/resolve', { catalogId: 'abc' })).status).toBe(400);
    const missing = await resolve(g, '777');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('catalog_not_found');
  });

  it('finds the official upload and gives it the catalog title and artwork', async () => {
    const g = await h.guest();
    const res = await resolve(g, '908604612');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'matched',
      track: {
        videoId: TOPIC,
        title: 'Blinding Lights',
        channelTitle: 'The Weeknd',
        thumbnailUrl: 'https://cdn-images.dzcdn.net/images/cover/908604612/250x250.jpg',
        durationSec: 201,
      },
      remainingSearchesToday: 9,
    });
    expect(h.searchCalls).toEqual(['the weeknd blinding lights']);
  });

  it('answers the same song for anyone else without YouTube or a search', async () => {
    await resolve(await h.guest(), '908604612');
    h.searchCalls.length = 0;
    h.youtubeCalls.length = 0;
    await h.redis.flushdb();
    const other = await h.guest();
    const res = await resolve(other, '908604612');
    expect(res.body).toMatchObject({ status: 'matched', remainingSearchesToday: 10 });
    expect(h.searchCalls).toHaveLength(0);
    expect(h.youtubeCalls).toHaveLength(0);
  });

  it('keeps the catalog metadata when YouTube details are refreshed', async () => {
    await resolve(await h.guest(), '908604612');
    await h.db.execute(`update tracks set fetched_at = now() - interval '2 days'`);
    const refreshed = (await h.youtube.getVideos([TOPIC])).get(TOPIC);
    expect(h.youtubeCalls).toContainEqual([TOPIC]);
    expect(refreshed).toMatchObject({ title: 'Blinding Lights', channelTitle: 'The Weeknd' });
  });

  it('offers the YouTube results when nothing matches', async () => {
    const res = await resolve(await h.guest(), '42');
    expect(res.body).toMatchObject({
      status: 'no_match',
      results: [{ videoId: 'someone0000', title: 'Unrelated' }],
      remainingSearchesToday: 9,
    });
    const rows = await h.db.execute('select 1 from catalog_matches');
    expect(rows.rowCount).toBe(0);
  });

  it('uses the daily search limit for songs nobody has added', async () => {
    await h.settings.set('limits.searchesPerUserPerDay', 0, null);
    const res = await resolve(await h.guest(), '908604612');
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('search_user_limit');
  });
});
