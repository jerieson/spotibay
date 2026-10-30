import type { Redis } from 'ioredis';
import { parseVideoId, VIDEO_ID_PATTERN, YOUTUBE_HOSTS, type Track } from '@spotibay/shared';
import { z } from 'zod';

/** Lives in shared so the web app can spot pasted links too. */
export { parseVideoId };

const VIDEOS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';
/** `videos.list` accepts at most 50 ids per call and costs 1 quota unit per call. */
const VIDEOS_BATCH = 50;
const VIDEOS_LIST_COST = 1;
const SEARCH_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';
/** `search.list` costs 100 quota units per call. */
const SEARCH_LIST_COST = 100;
const SEARCH_MAX_RESULTS = 15;
const PLAYLIST_ITEMS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/playlistItems';
/** `playlistItems.list` returns at most 50 items per page and costs 1 quota unit per call. */
const PLAYLIST_PAGE_SIZE = 50;
const PLAYLIST_ITEMS_COST = 1;
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;
/** Stored track details are reused for this long before asking YouTube again. */
const TRACK_TTL_MS = 24 * 60 * 60 * 1000;
/** Ids YouTube didn't know are not asked about again for this long, so repeats cost no quota. */
const MISSING_TTL_MS = 60 * 60 * 1000;
const MISSING_MAX_ENTRIES = 10_000;
const LOOKUP_COUNT_TTL_SEC = 2 * 24 * 60 * 60;

export interface StoredTrack extends Track {
  embeddable: boolean;
  fetchedAt: Date;
}

export interface TrackStore {
  findMany(videoIds: string[]): Promise<StoredTrack[]>;
  /** Saves YouTube's details and resolves with the rows as stored, which keep catalog metadata. */
  upsertMany(tracks: StoredTrack[]): Promise<StoredTrack[]>;
}

export interface QuotaStore {
  /** Adds to the counters for `date` (YYYY-MM-DD, Pacific Time). */
  add(date: string, units: number, searchCalls: number): Promise<void>;
  /** What has been spent on `date` so far. */
  get(date: string): Promise<{ units: number; searchCalls: number }>;
}

export type YouTubeErrorCode =
  | 'not_configured'
  | 'api_error'
  | 'not_found'
  | 'user_limit'
  /** The project's daily quota is spent; calls start working again at Pacific midnight. */
  | 'quota_exceeded';

/** What people see when a YouTube call fails for a reason other than their own input. */
export function youtubeFailureMessage(err: YouTubeError): string {
  switch (err.code) {
    case 'not_configured':
      return 'Adding songs from YouTube is not set up on this server';
    case 'quota_exceeded':
      return "YouTube's daily limit is reached, so new videos can't be checked until it resets. Songs already in Spotibay still work.";
    default:
      return "Spotibay can't reach YouTube right now. Try again in a moment.";
  }
}

export class YouTubeError extends Error {
  constructor(
    readonly code: YouTubeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'YouTubeError';
  }
}

/** Extracts the playlist id from a YouTube link that has a `list` parameter; `null` if there is none. */
export function parsePlaylistId(input: string): string | null {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const id = url.searchParams.get('list');
  return id && PLAYLIST_ID_PATTERN.test(id) ? id : null;
}

/** ISO 8601 duration as returned by YouTube (`PT1H2M3S`, `P1DT2H`, `P0D` for live) to whole seconds. */
export function parseIsoDuration(value: string): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match || value === 'P' || value.endsWith('T')) return null;
  const [days = 0, hours = 0, minutes = 0, seconds = 0] = match.slice(1).map((n) => Number(n ?? 0));
  return days * 86_400 + hours * 3600 + minutes * 60 + seconds;
}

/** The date quota resets on: midnight Pacific Time. */
export function quotaDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
}

/** When the quota resets next: the coming midnight Pacific Time (UTC-8, or UTC-7 in summer). */
export function quotaResetAt(now: Date): Date {
  const [y, m, d] = quotaDate(now).split('-').map(Number) as [number, number, number];
  for (const offsetHours of [7, 8]) {
    const candidate = new Date(Date.UTC(y, m - 1, d + 1, offsetHours));
    if (quotaDate(new Date(candidate.getTime() - 1)) !== quotaDate(candidate)) return candidate;
  }
  return new Date(Date.UTC(y, m - 1, d + 1, 8));
}

const videosResponseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        snippet: z.object({
          title: z.string(),
          channelTitle: z.string(),
          thumbnails: z
            .record(z.string(), z.object({ url: z.string() }))
            .optional()
            .default({}),
        }),
        contentDetails: z.object({ duration: z.string() }),
        status: z
          .object({ embeddable: z.boolean().optional(), privacyStatus: z.string().optional() })
          .optional(),
      }),
    )
    .default([]),
});

const playlistItemsResponseSchema = z.object({
  items: z.array(z.object({ contentDetails: z.object({ videoId: z.string() }) })).default([]),
  nextPageToken: z.string().optional(),
});

/** Google's error body; `reason` tells a spent quota apart from other refusals. */
const errorResponseSchema = z.object({
  error: z.object({
    errors: z.array(z.object({ reason: z.string().optional() })).default([]),
  }),
});
const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);

const searchResponseSchema = z.object({
  items: z.array(z.object({ id: z.object({ videoId: z.string().optional() }) })).default([]),
});

/** Spends one quota-costing lookup for a person; resolves `false` once they are over today's cap. */
export type LookupCharger = (userId: string) => Promise<boolean>;

/** Per-person daily lookup cap in Redis (`ytlookups:{userId}:{date}`, Pacific Time like the quota). */
export function createLookupCharger(
  redis: Redis,
  perUserPerDay: () => number,
  now: () => Date = () => new Date(),
): LookupCharger {
  return async (userId) => {
    const key = `ytlookups:${userId}:${quotaDate(now())}`;
    const results = await redis.multi().incr(key).expire(key, LOOKUP_COUNT_TTL_SEC).exec();
    const [err, used] = results?.[0] ?? [new Error('lookup count transaction aborted'), 0];
    if (err) throw err;
    if (Number(used) <= perUserPerDay()) return true;
    await redis.decr(key);
    return false;
  };
}

/** Remembers that YouTube refused for quota today, so later calls don't ask again until it resets. */
export interface QuotaFlag {
  isSet(date: string): Promise<boolean>;
  set(date: string): Promise<void>;
}

/** Quota flag in Redis (`yt:exhausted:{date}`), shared by every API process. */
export function createQuotaFlag(redis: Redis): QuotaFlag {
  const key = (date: string) => `yt:exhausted:${date}`;
  return {
    isSet: async (date) => (await redis.exists(key(date))) === 1,
    set: async (date) => void (await redis.set(key(date), '1', 'EX', LOOKUP_COUNT_TTL_SEC)),
  };
}

export interface YouTubeServiceDeps {
  apiKey: string | undefined;
  tracks: TrackStore;
  quota: QuotaStore;
  /** Caps the lookups one person can trigger; uncapped when omitted. */
  chargeLookup?: LookupCharger;
  /** Without one, a spent quota is only noticed when YouTube refuses each call. */
  quotaFlag?: QuotaFlag;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function createYouTubeService({
  apiKey,
  tracks,
  quota,
  chargeLookup,
  quotaFlag,
  fetch: fetchImpl = fetch,
  now = () => new Date(),
}: YouTubeServiceDeps) {
  /** videoId -> when we may ask YouTube about it again. Insertion order doubles as age order. */
  const missing = new Map<string, number>();

  function rememberMissing(ids: string[]) {
    const until = now().getTime() + MISSING_TTL_MS;
    for (const id of ids) {
      missing.delete(id);
      missing.set(id, until);
    }
    for (const oldest of missing.keys()) {
      if (missing.size <= MISSING_MAX_ENTRIES) break;
      missing.delete(oldest);
    }
  }

  function knownMissing(id: string): boolean {
    const until = missing.get(id);
    if (until === undefined) return false;
    if (until > now().getTime()) return true;
    missing.delete(id);
    return false;
  }

  const quotaError = () =>
    new YouTubeError('quota_exceeded', "YouTube's daily limit for Spotibay is used up");

  /** Refuses before calling YouTube when there is no key or today's quota is already spent. */
  async function ready() {
    if (!apiKey) throw new YouTubeError('not_configured', 'YouTube is not configured');
    if (await quotaFlag?.isSet(quotaDate(now()))) throw quotaError();
  }

  /** The error for a refused call; a spent quota is also remembered for the rest of the day. */
  async function failure(res: Response): Promise<YouTubeError> {
    if (res.status === 403) {
      const body = errorResponseSchema.safeParse(await res.json().catch(() => null));
      if (body.success && body.data.error.errors.some((e) => QUOTA_REASONS.has(e.reason ?? ''))) {
        await quotaFlag?.set(quotaDate(now()));
        return quotaError();
      }
    }
    return new YouTubeError('api_error', `YouTube API returned ${res.status}`);
  }

  /** Charges a lookup to `userId` (if given), refusing once they are over their cap. */
  async function charge(userId: string | undefined) {
    if (!chargeLookup || userId === undefined) return;
    if (!(await chargeLookup(userId))) {
      throw new YouTubeError('user_limit', "You've looked up too many new videos today");
    }
  }

  async function fetchVideos(ids: string[], userId: string | undefined): Promise<StoredTrack[]> {
    await ready();
    await charge(userId);
    const url = new URL(VIDEOS_ENDPOINT);
    url.searchParams.set('part', 'snippet,contentDetails,status');
    url.searchParams.set('id', ids.join(','));
    url.searchParams.set('key', apiKey!);
    const res = await fetchImpl(url);
    // A failed call may still have cost quota, so count every request that was made.
    await quota.add(quotaDate(now()), VIDEOS_LIST_COST, 0);
    if (!res.ok) throw await failure(res);
    const parsed = videosResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new YouTubeError('api_error', 'Unexpected YouTube API response');
    const fetchedAt = now();
    return parsed.data.items.map((item) => {
      const thumbs = item.snippet.thumbnails;
      const thumb = thumbs.medium ?? thumbs.high ?? thumbs.default ?? Object.values(thumbs)[0];
      return {
        videoId: item.id,
        title: item.snippet.title,
        channelTitle: item.snippet.channelTitle,
        thumbnailUrl: thumb?.url ?? `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
        durationSec: parseIsoDuration(item.contentDetails.duration) ?? 0,
        embeddable: item.status?.embeddable !== false && item.status?.privacyStatus !== 'private',
        fetchedAt,
      };
    });
  }

  /**
   * Details for the given videos, from the track table when fresh, else from `videos.list`.
   * Unknown ids are absent. Calls YouTube makes for `userId` count toward their daily cap.
   * Once the quota is spent, older stored details are used rather than failing.
   */
  async function getVideos(videoIds: string[], userId?: string): Promise<Map<string, StoredTrack>> {
    const ids = [...new Set(videoIds)].filter((id) => VIDEO_ID_PATTERN.test(id));
    const result = new Map<string, StoredTrack>();
    const stale = new Map<string, StoredTrack>();
    const cutoff = now().getTime() - TRACK_TTL_MS;
    for (const track of await tracks.findMany(ids)) {
      if (track.fetchedAt.getTime() >= cutoff) result.set(track.videoId, track);
      else stale.set(track.videoId, track);
    }
    const toFetch = ids.filter((id) => !result.has(id) && !knownMissing(id));
    try {
      for (let i = 0; i < toFetch.length; i += VIDEOS_BATCH) {
        const batch = toFetch.slice(i, i + VIDEOS_BATCH);
        const stored = await tracks.upsertMany(await fetchVideos(batch, userId));
        for (const track of stored) result.set(track.videoId, track);
        rememberMissing(batch.filter((id) => !result.has(id)));
      }
    } catch (err) {
      // Videos we have never seen can't be checked without quota; the rest can wait a day.
      const quotaSpent = err instanceof YouTubeError && err.code === 'quota_exceeded';
      if (!quotaSpent || toFetch.some((id) => !result.has(id) && !stale.has(id))) throw err;
      for (const [id, track] of stale) if (!result.has(id)) result.set(id, track);
    }
    return result;
  }

  /** Top embeddable video matches for `query`, with durations (one `search.list` plus one `videos.list` for uncached ids). */
  async function search(query: string): Promise<StoredTrack[]> {
    await ready();
    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('videoEmbeddable', 'true');
    url.searchParams.set('maxResults', String(SEARCH_MAX_RESULTS));
    url.searchParams.set('q', query);
    url.searchParams.set('key', apiKey!);
    const res = await fetchImpl(url);
    await quota.add(quotaDate(now()), SEARCH_LIST_COST, 1);
    if (!res.ok) throw await failure(res);
    const parsed = searchResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new YouTubeError('api_error', 'Unexpected YouTube API response');
    const ids = parsed.data.items.flatMap((item) => item.id.videoId ?? []);
    const details = await getVideos(ids);
    return [...new Set(ids)].flatMap((id) => {
      const track = details.get(id);
      return track?.embeddable && track.durationSec > 0 ? [track] : [];
    });
  }

  /** Video ids of a public YouTube playlist in order, at most `max` of them (one call per 50, charged to `userId`). */
  async function getPlaylistVideoIds(
    playlistId: string,
    max: number,
    userId?: string,
  ): Promise<string[]> {
    await ready();
    const ids: string[] = [];
    let pageToken: string | undefined;
    while (ids.length < max) {
      const url = new URL(PLAYLIST_ITEMS_ENDPOINT);
      url.searchParams.set('part', 'contentDetails');
      url.searchParams.set('playlistId', playlistId);
      url.searchParams.set('maxResults', String(PLAYLIST_PAGE_SIZE));
      url.searchParams.set('key', apiKey!);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      await charge(userId);
      const res = await fetchImpl(url);
      await quota.add(quotaDate(now()), PLAYLIST_ITEMS_COST, 0);
      if (!res.ok) {
        const err = await failure(res);
        // Missing and private playlists look the same to us.
        if (err.code !== 'quota_exceeded' && (res.status === 404 || res.status === 403)) {
          throw new YouTubeError('not_found', 'That playlist was not found or is private');
        }
        throw err;
      }
      const parsed = playlistItemsResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new YouTubeError('api_error', 'Unexpected YouTube API response');
      for (const item of parsed.data.items) {
        if (VIDEO_ID_PATTERN.test(item.contentDetails.videoId))
          ids.push(item.contentDetails.videoId);
      }
      pageToken = parsed.data.nextPageToken;
      if (!pageToken) break;
    }
    return ids.slice(0, max);
  }

  return { getVideos, search, getPlaylistVideoIds };
}

export type YouTubeService = ReturnType<typeof createYouTubeService>;
