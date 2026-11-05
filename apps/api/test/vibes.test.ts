import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { VibeResponse } from '@spotibay/shared';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

/** The pinned playlists of the Focus vibe (see services/vibes.ts). */
const FOCUS = ['8749343942', '8749345882', '4590807924'];

beforeEach(async () => {
  await h.redis.flushdb();
  await h.db.execute('truncate table tracks, rooms, api_quota_usage cascade');
  for (const m of [h.catalogSongs, h.deezerPlaylists, h.deezerPlaylistSearch, h.appleCharts]) {
    m.clear();
  }
  h.deezerChart.length = 0;
  h.catalogCalls.length = 0;
  h.searchCalls.length = 0;
  h.deezer.errorCode = null;
  await h.settings.set('features.catalogSearch', true, null);
  await h.settings.set('search.region', '', null);

  // Three songs by each of five artists, spread over the Focus playlists.
  for (let artist = 1; artist <= 5; artist++) {
    for (let n = 1; n <= 3; n++) {
      h.catalogSongs.set(`${artist}0${n}`, {
        title: `Calm ${artist}-${n}`,
        artist: `Artist ${artist}`,
        artistId: String(artist),
        durationSec: 180,
      });
    }
  }
  h.deezerPlaylists.set(FOCUS[0]!, ['101', '102', '103', '201', '202']);
  h.deezerPlaylists.set(FOCUS[1]!, ['203', '301', '302', '303', '101']);
  h.deezerPlaylists.set(FOCUS[2]!, ['401', '402', '403', '501', '502', '503']);
});

type Guest = Awaited<ReturnType<Harness['guest']>>;
const vibe = (g: Guest, id: string) =>
  g.api<VibeResponse & { error?: string }>('GET', `/vibes/${id}`);
const ids = (res: { body: VibeResponse }) => res.body.suggestions.map((s) => s.id);

describe('GET /api/vibes/:id', () => {
  it('requires a session and a known vibe', async () => {
    expect((await fetch(`${h.baseUrl}/api/vibes/focus`)).status).toBe(401);
    const g = await h.guest();
    expect((await vibe(g, 'nope')).status).toBe(404);
  });

  it("mixes the vibe's playlists, at most two songs per artist, without YouTube", async () => {
    const g = await h.guest();
    const res = await vibe(g, 'focus');
    expect(res.status).toBe(200);
    const got = ids(res);
    expect(got).toHaveLength(10);
    expect(new Set(got).size).toBe(got.length);
    for (let artist = 1; artist <= 5; artist++) {
      expect(got.filter((id) => id.startsWith(String(artist)))).toHaveLength(2);
    }
    expect(h.searchCalls).toHaveLength(0);
    // The same person gets the same mix all day, from cached playlists.
    const calls = h.catalogCalls.length;
    expect(ids(await vibe(g, 'focus'))).toEqual(got);
    expect(h.catalogCalls).toHaveLength(calls);
  });

  it("uses an editor's playlist in place of a pinned one that is gone", async () => {
    h.deezerPlaylists.delete(FOCUS[2]!);
    h.deezerPlaylists.set('777', ['401', '402']);
    h.deezerPlaylists.set('888', ['501']);
    h.deezerPlaylistSearch.set('focus', [
      { id: 888, user: { name: 'someone' } },
      { id: 777, user: { name: 'Rudy - Deezer Moods Editor' } },
    ]);
    const got = ids(await vibe(await h.guest(), 'focus'));
    expect(got).toEqual(expect.arrayContaining(['401', '402']));
    expect(got).not.toContain('501');
  });

  it('shows the chart for Trending', async () => {
    h.deezerChart.push('301', '101');
    expect(ids(await vibe(await h.guest(), 'trending'))).toEqual(['301', '101']);
  });

  it('reports a busy catalog and the feature switch', async () => {
    const g = await h.guest();
    h.deezer.errorCode = 4;
    const busy = await vibe(g, 'focus');
    expect(busy.status).toBe(503);
    expect(busy.body.error).toBe('catalog_unavailable');
    await h.settings.set('features.catalogSearch', false, null);
    expect((await vibe(g, 'focus')).status).toBe(403);
  });
});
