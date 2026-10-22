import { describe, expect, it } from 'vitest';
import { expectedPositionMs, type PlaybackState } from '@spotibay/shared';
import {
  createYouTubeService,
  parseIsoDuration,
  parseVideoId,
  quotaDate,
  YouTubeError,
  type StoredTrack,
} from '../src/services/youtube.js';

describe('parseVideoId', () => {
  const id = 'dQw4w9WgXcQ';
  it.each([
    [`https://www.youtube.com/watch?v=${id}`],
    [`https://youtube.com/watch?v=${id}&t=42s&list=PL123`],
    [`http://m.youtube.com/watch?v=${id}`],
    [`https://music.youtube.com/watch?v=${id}&si=abc`],
    [`https://youtu.be/${id}?si=abc`],
    [`https://www.youtube.com/shorts/${id}`],
    [`youtube.com/watch?v=${id}`],
    [`  ${id}  `],
  ])('extracts the id from %s', (input) => {
    expect(parseVideoId(input)).toBe(id);
  });

  it.each([
    [''],
    ['not a link'],
    ['https://example.com/watch?v=dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=short'],
    ['https://www.youtube.com/playlist?list=PL123'],
    ['javascript:alert(1)'],
    ['https://youtu.be/'],
    ['dQw4w9WgXc'],
  ])('rejects %j', (input) => {
    expect(parseVideoId(input)).toBeNull();
  });
});

describe('parseIsoDuration', () => {
  it.each([
    ['PT3M20S', 200],
    ['PT1H', 3600],
    ['PT1H2M3S', 3723],
    ['PT45S', 45],
    ['P1DT1H', 90_000],
    ['P0D', 0],
  ])('%s is %d seconds', (input, seconds) => {
    expect(parseIsoDuration(input)).toBe(seconds);
  });

  it.each([[''], ['P'], ['PT'], ['3:20'], ['PT-5S']])('rejects %j', (input) => {
    expect(parseIsoDuration(input)).toBeNull();
  });
});

describe('quotaDate', () => {
  it('uses the Pacific calendar day', () => {
    expect(quotaDate(new Date('2026-01-15T07:30:00Z'))).toBe('2026-01-14');
    expect(quotaDate(new Date('2026-01-15T08:30:00Z'))).toBe('2026-01-15');
  });
});

describe('expectedPositionMs', () => {
  const item = {
    id: 'i',
    track: { videoId: 'v', title: 't', channelTitle: 'c', thumbnailUrl: 'u', durationSec: 100 },
    addedBy: { userId: 'u', displayName: 'n', avatar: { style: 'thumbs', seed: 's', options: {} } },
  } as const;
  const base: PlaybackState = {
    status: 'playing',
    item,
    positionMs: 5_000,
    refServerTime: 1_000,
    version: 1,
  };

  it('advances with the server clock while playing', () => {
    expect(expectedPositionMs(base, 3_500)).toBe(7_500);
  });
  it('stays put while paused or idle', () => {
    expect(expectedPositionMs({ ...base, status: 'paused' }, 99_000)).toBe(5_000);
    expect(expectedPositionMs({ ...base, status: 'idle', item: null }, 99_000)).toBe(5_000);
  });
  it('never goes backwards or past the end', () => {
    expect(expectedPositionMs(base, 0)).toBe(5_000);
    expect(expectedPositionMs(base, 10_000_000)).toBe(100_000);
  });
});

describe('YouTube service', () => {
  function setup(opts: { apiKey?: string | undefined; failWith?: number } = {}) {
    const stored = new Map<string, StoredTrack>();
    const quota: Array<[string, number, number]> = [];
    const calls: URL[] = [];
    let clock = new Date('2026-03-01T12:00:00Z');
    const fetchFake = (async (input: URL) => {
      calls.push(input);
      if (opts.failWith) return new Response('{}', { status: opts.failWith });
      const ids = (input.searchParams.get('id') ?? '').split(',');
      const items = ids.map((id) => ({
        id,
        snippet: { title: `T ${id}`, channelTitle: 'C', thumbnails: { default: { url: 'u' } } },
        contentDetails: { duration: 'PT2M' },
        status: { embeddable: id !== 'aaaaaaaaaaz' },
      }));
      return new Response(JSON.stringify({ items }), { status: 200 });
    }) as typeof fetch;
    const service = createYouTubeService({
      apiKey: 'apiKey' in opts ? opts.apiKey : 'k',
      tracks: {
        findMany: async (ids) => ids.flatMap((id) => stored.get(id) ?? []),
        upsertMany: async (rows) => rows.forEach((r) => stored.set(r.videoId, r)),
        markUnembeddable: async () => undefined,
      },
      quota: {
        add: async (d, u, s) => void quota.push([d, u, s]),
        get: async () => ({ units: 0, searchCalls: 0 }),
      },
      fetch: fetchFake,
      now: () => clock,
    });
    return {
      service,
      stored,
      quota,
      calls,
      advance: (ms: number) => (clock = new Date(+clock + ms)),
    };
  }

  const ids = (n: number) => Array.from({ length: n }, (_, i) => `id${String(i).padStart(9, '0')}`);

  it('fetches, stores and records quota for one call', async () => {
    const { service, stored, quota, calls } = setup();
    const res = await service.getVideos(['aaaaaaaaaaa']);
    expect(res.get('aaaaaaaaaaa')).toMatchObject({ durationSec: 120, embeddable: true });
    expect(stored.has('aaaaaaaaaaa')).toBe(true);
    expect(quota).toEqual([['2026-03-01', 1, 0]]);
    expect(calls[0]?.searchParams.get('part')).toBe('snippet,contentDetails,status');
  });

  it('reuses fresh stored tracks and refetches stale ones', async () => {
    const { service, calls, advance } = setup();
    await service.getVideos(['aaaaaaaaaaa']);
    await service.getVideos(['aaaaaaaaaaa']);
    expect(calls).toHaveLength(1);
    advance(25 * 60 * 60 * 1000);
    await service.getVideos(['aaaaaaaaaaa']);
    expect(calls).toHaveLength(2);
  });

  it('batches 50 ids per request and records each call', async () => {
    const { service, quota, calls } = setup();
    const res = await service.getVideos(ids(120));
    expect(res.size).toBe(120);
    expect(calls).toHaveLength(3);
    expect(quota.map((q) => q[1])).toEqual([1, 1, 1]);
  });

  it('flags non-embeddable videos and ignores malformed ids', async () => {
    const { service, calls } = setup();
    const res = await service.getVideos(['aaaaaaaaaaz', 'bad']);
    expect(res.get('aaaaaaaaaaz')?.embeddable).toBe(false);
    expect(calls[0]?.searchParams.get('id')).toBe('aaaaaaaaaaz');
  });

  it('fails clearly without a key or when the API errors', async () => {
    await expect(setup({ apiKey: undefined }).service.getVideos(['aaaaaaaaaaa'])).rejects.toThrow(
      YouTubeError,
    );
    const failing = setup({ failWith: 403 });
    await expect(failing.service.getVideos(['aaaaaaaaaaa'])).rejects.toMatchObject({
      code: 'api_error',
    });
    expect(failing.quota).toHaveLength(1);
  });
});
