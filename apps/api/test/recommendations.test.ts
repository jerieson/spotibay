import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RecommendationsResponse } from '@spotibay/shared';
import { listenHistory, queueItems, rooms, tracks } from '../src/db/schema.js';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const COJ = '1';
const BENBEN = '2';
const ZACK = '3';
const ADIE = '4';

beforeEach(async () => {
  await h.redis.flushdb();
  await h.db.execute('truncate table tracks, rooms, api_quota_usage cascade');
  for (const m of [h.catalogSongs, h.catalogSearch, h.artistRadios, h.appleCharts]) m.clear();
  h.lastfmSimilar.clear();
  h.lastfmCalls.length = 0;
  h.deezerChart.length = 0;
  h.catalogCalls.length = 0;
  h.searchCalls.length = 0;
  h.youtubeCalls.length = 0;
  h.deezer.errorCode = null;
  await h.settings.set('features.catalogSearch', true, null);
  // No Apple chart in tests: the cold start falls back to Deezer's own chart.
  await h.settings.set('search.region', '', null);

  const song = (id: string, title: string, artist: string, artistId: string, rank: number) =>
    h.catalogSongs.set(id, { title, artist, artistId, rank, durationSec: 240 });
  song('101', 'Multo', 'Cup of Joe', COJ, 400_000);
  song('102', 'Pahina', 'Cup of Joe', COJ, 270_000);
  song('103', 'Estranghero', 'Cup of Joe', COJ, 140_000);
  song('104', 'Bukod-Tangi', 'Cup of Joe', COJ, 110_000);
  song('201', 'Kathang Isip', 'Ben&Ben', BENBEN, 500_000);
  song('202', 'Maybe the Night', 'Ben&Ben', BENBEN, 300_000);
  song('301', 'Gusto', 'Zack Tabudlo', ZACK, 250_000);
  song('401', 'Mahika', 'Adie', ADIE, 270_000);
  h.catalogSongs.set('501', {
    title: 'Multo (Karaoke Version)',
    artist: 'Sing King',
    album: 'Karaoke Hits',
    artistId: '9',
    durationSec: 240,
  });
  h.artistRadios.set(COJ, ['102', '103', '104', '201', '301', '101', '501']);
  h.artistRadios.set(BENBEN, ['202', '301', '401']);
  h.deezerChart.push('201', '301');
});

type Guest = Awaited<ReturnType<Harness['guest']>>;

const recommendations = (g: Guest) =>
  g.api<RecommendationsResponse & { error?: string }>('GET', '/recommendations');

let codes = 0;
async function room(ownerId: string) {
  const [row] = await h.db
    .insert(rooms)
    .values({ code: `RECS${String(codes++).padStart(2, '0')}`, name: 'Test', ownerId })
    .returning();
  return row!;
}

/** Records plays oldest first, as the app does: a track per entry, with its catalog id if any. */
async function played(
  userId: string,
  roomId: string,
  plays: { videoId: string; title: string; channelTitle?: string; catalogId?: string }[],
) {
  for (const p of plays) {
    await h.db
      .insert(tracks)
      .values({
        videoId: p.videoId,
        title: p.title,
        channelTitle: p.channelTitle ?? 'Someone',
        durationSec: 240,
        thumbnailUrl: 'https://i.ytimg.com/x.jpg',
        catalogId: p.catalogId ?? null,
      })
      .onConflictDoNothing();
    await h.db.insert(listenHistory).values({ userId, videoId: p.videoId, roomId });
  }
}

const ids = (res: { body: RecommendationsResponse }) => res.body.suggestions.map((s) => s.id);

describe('GET /api/recommendations', () => {
  it('requires a session', async () => {
    expect((await fetch(`${h.baseUrl}/api/recommendations`)).status).toBe(401);
  });

  it('shows the top chart to someone who has played nothing', async () => {
    const g = await h.guest();
    const res = await recommendations(g);
    expect(res.status).toBe(200);
    expect(res.body.basedOn).toBe('chart');
    expect(ids(res)).toEqual(['201', '301']);
  });

  it('suggests from the radios of the artists played, without YouTube', async () => {
    const g = await h.guest();
    const r = await room(g.user.id);
    await played(g.user.id, r.id, [
      { videoId: 'kathang0000', title: 'Kathang Isip', catalogId: '201' },
      { videoId: 'multo000000', title: 'Multo', catalogId: '101' },
    ]);
    const res = await recommendations(g);
    expect(res.status).toBe(200);
    expect(res.body.basedOn).toBe('history');
    const got = ids(res);
    // Gusto is on both radios, so it leads.
    expect(got[0]).toBe('301');
    // Played songs and the karaoke version are left out, and no artist gets more than two.
    expect(got).not.toContain('101');
    expect(got).not.toContain('201');
    expect(got).not.toContain('501');
    expect(got.filter((id) => ['102', '103', '104'].includes(id))).toHaveLength(2);
    expect(got).toEqual(expect.arrayContaining(['202', '401']));
    expect(h.searchCalls).toHaveLength(0);
    expect(h.youtubeCalls).toHaveLength(0);
  });

  it('weighs the artists played most recently highest', async () => {
    const g = await h.guest();
    const r = await room(g.user.id);
    await played(g.user.id, r.id, [
      { videoId: 'multo000000', title: 'Multo', catalogId: '101' },
      { videoId: 'kathang0000', title: 'Kathang Isip', catalogId: '201' },
    ]);
    const got = ids(await recommendations(g));
    // Ben&Ben was played last, so their radio's own songs come before Cup of Joe's.
    expect(got.indexOf('202')).toBeLessThan(got.indexOf('102'));
  });

  it('finds the catalog song of a pasted YouTube link once', async () => {
    const g = await h.guest();
    const r = await room(g.user.id);
    h.catalogSearch.set('cup of joe multo', ['101']);
    await played(g.user.id, r.id, [
      {
        videoId: 'pasted00000',
        title: 'Cup of Joe - Multo (Official Music Video)',
        channelTitle: 'Cup of Joe',
      },
    ]);
    const res = await recommendations(g);
    expect(res.body.basedOn).toBe('history');
    expect(ids(res)).toContain('102');
    expect(ids(res)).not.toContain('101');

    // A new person who played the same video reuses the lookup.
    const other = await h.guest();
    await played(other.user.id, r.id, [{ videoId: 'pasted00000', title: 'unused' }]);
    await recommendations(other);
    expect(h.catalogCalls.filter((c) => c.startsWith('/search/track'))).toHaveLength(1);
  });

  it('takes a longer music video for the studio song, not its live version', async () => {
    const g = await h.guest();
    const r = await room(g.user.id);
    h.catalogSongs.set('601', {
      title: 'Blinding Lights (Live)',
      artist: 'The Weeknd',
      artistId: '6',
      durationSec: 245,
    });
    h.catalogSongs.set('602', {
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      artistId: '6',
      durationSec: 200,
    });
    h.catalogSearch.set('the weeknd blinding lights', ['601', '602']);
    await played(g.user.id, r.id, [
      {
        videoId: 'weekndmv000',
        title: 'The Weeknd - Blinding Lights (Official Video)',
        channelTitle: 'TheWeekndVEVO',
      },
    ]);
    await recommendations(g);
    expect(await h.redis.get('catalog:forvideo:weekndmv000')).toBe('602');
  });

  it('ignores a pasted video that no catalog song confidently is', async () => {
    const g = await h.guest();
    const r = await room(g.user.id);
    h.catalogSearch.set('my vlog', ['101']);
    await played(g.user.id, r.id, [{ videoId: 'vlog0000000', title: 'My vlog' }]);
    expect((await recommendations(g)).body.basedOn).toBe('chart');
  });

  it('keeps the answer for a while', async () => {
    const g = await h.guest();
    const r = await room(g.user.id);
    await played(g.user.id, r.id, [{ videoId: 'multo000000', title: 'Multo', catalogId: '101' }]);
    const first = await recommendations(g);
    const calls = h.catalogCalls.length;
    expect(await recommendations(g)).toEqual(first);
    expect(h.catalogCalls).toHaveLength(calls);
  });

  it('reports a busy catalog and the feature switch', async () => {
    const g = await h.guest();
    const r = await room(g.user.id);
    await played(g.user.id, r.id, [{ videoId: 'multo000000', title: 'Multo', catalogId: '101' }]);
    h.deezer.errorCode = 4;
    const busy = await recommendations(g);
    expect(busy.status).toBe(503);
    expect(busy.body.error).toBe('catalog_unavailable');

    await h.settings.set('features.catalogSearch', false, null);
    const off = await recommendations(g);
    expect(off.status).toBe(403);
    expect(off.body.error).toBe('catalog_disabled');
  });
});

describe('room recommendations', () => {
  it("come from the room's recent plays", async () => {
    const g = await h.guest();
    const r = await room(g.user.id);
    await played(g.user.id, r.id, [
      { videoId: 'kathang0000', title: 'Kathang Isip', catalogId: '201' },
    ]);
    await h.db.insert(queueItems).values({
      roomId: r.id,
      videoId: 'kathang0000',
      addedBy: g.user.id,
      position: 1,
      status: 'played',
      startedAt: new Date(),
    });
    const got = (await h.recommendations.forRoom(r.id)).map((s) => s.id);
    expect(got).toEqual(['202', '301', '401']);
    expect(await h.recommendations.forRoom((await room(g.user.id)).id)).toEqual([]);
  });

  it('leave out songs skipped in the room', async () => {
    const g = await h.guest();
    const r = await room(g.user.id);
    await played(g.user.id, r.id, [
      { videoId: 'kathang0000', title: 'Kathang Isip', catalogId: '201' },
      { videoId: 'maybe000000', title: 'Maybe the Night', catalogId: '202' },
    ]);
    const at = Date.now();
    await h.db.insert(queueItems).values([
      {
        roomId: r.id,
        videoId: 'kathang0000',
        addedBy: g.user.id,
        position: 1,
        status: 'played',
        startedAt: new Date(at - 2000),
      },
      {
        roomId: r.id,
        videoId: 'maybe000000',
        addedBy: g.user.id,
        position: 2,
        status: 'skipped',
        startedAt: new Date(at - 1000),
        endedAt: new Date(at),
      },
    ]);
    const got = (await h.recommendations.forRoom(r.id)).map((s) => s.id);
    expect(got).toEqual(['301', '401']);
  });
});

describe('picks led by the last song', () => {
  it("put Last.fm's similar songs to the last song first, and say which song", async () => {
    const g = await h.guest();
    const r = await room(g.user.id);
    h.lastfmSimilar.set('cup of joe|multo', [{ title: 'Mahika', artist: 'Adie', match: 1 }]);
    h.catalogSearch.set('adie mahika', ['401']);
    await played(g.user.id, r.id, [
      { videoId: 'kathang0000', title: 'Kathang Isip', channelTitle: 'Ben&Ben', catalogId: '201' },
      { videoId: 'multo000000', title: 'Multo', channelTitle: 'Cup of Joe', catalogId: '101' },
    ]);
    const res = await recommendations(g);
    expect(res.body.seed).toEqual({ title: 'Multo', artist: 'Cup of Joe' });
    expect(ids(res)[0]).toBe('401');
    expect(h.lastfmCalls).toContain('cup of joe|multo');

    // Playing another song gives a new list, led by that one.
    await played(g.user.id, r.id, [
      { videoId: 'gusto000000', title: 'Gusto', channelTitle: 'Zack Tabudlo', catalogId: '301' },
    ]);
    expect((await recommendations(g)).body.seed).toEqual({
      title: 'Gusto',
      artist: 'Zack Tabudlo',
    });
  });

  it('count what people in Spotibay chose right after the song, but not autoplay picks', async () => {
    const g = await h.guest();
    const track = (videoId: string, title: string, catalogId: string) =>
      h.db
        .insert(tracks)
        .values({
          videoId,
          title,
          channelTitle: 'Someone',
          durationSec: 240,
          thumbnailUrl: 'https://i.ytimg.com/x.jpg',
          catalogId,
        })
        .onConflictDoNothing();
    await track('bukod000000', 'Bukod-Tangi', '104');
    await track('estrang0000', 'Estranghero', '103');
    let at = Date.now() - 60_000;
    async function session(next: string, source: 'user' | 'autoplay') {
      const r = await room(g.user.id);
      for (const [i, videoId] of ['kathang0000', next].entries()) {
        await h.db.insert(queueItems).values({
          roomId: r.id,
          videoId,
          addedBy: g.user.id,
          position: i + 1,
          status: 'played',
          source: i === 0 ? 'user' : source,
          startedAt: new Date((at += 1000)),
        });
      }
    }
    await played(g.user.id, (await room(g.user.id)).id, [
      { videoId: 'kathang0000', title: 'Kathang Isip', catalogId: '201' },
    ]);
    await session('bukod000000', 'user');
    await session('bukod000000', 'user');
    await session('estrang0000', 'autoplay');
    await session('estrang0000', 'autoplay');
    await session('estrang0000', 'autoplay');

    const other = await h.guest();
    await played(other.user.id, (await room(other.user.id)).id, [
      { videoId: 'kathang0000', title: 'Kathang Isip', catalogId: '201' },
    ]);
    const got = ids(await recommendations(other));
    expect(got[0]).toBe('104');
    expect(got).not.toContain('103');
  });
});
