import type { Redis } from 'ioredis';
import {
  chatMediaSchema,
  GIF_PAGE_SIZE,
  type ChatMedia,
  type ChatMediaKind,
  type GifErrorCode,
  type GifSearchResponse,
} from '@spotibay/shared';
import { z } from 'zod';
import { hit } from '../lib/rate-limit.js';
import type { SettingsService } from './settings.js';

const KLIPY_API = 'https://api.klipy.com/api/v1';
/** Chat media stays resolvable this long after it last showed up in a search. */
const ITEM_TTL_SEC = 7 * 24 * 60 * 60;
const TIMEOUT_MS = 8000;

export class GifError extends Error {
  constructor(
    readonly code: GifErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GifError';
  }
}

/** Media must come from KLIPY's own hosts; the CSP allows the same ones. */
export function isKlipyMediaUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'klipy.com' || url.hostname.endsWith('.klipy.com'))
    );
  } catch {
    return false;
  }
}

const fileSchema = z.object({
  url: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
const formatsSchema = z
  .object({ gif: fileSchema, webp: fileSchema, png: fileSchema })
  .partial()
  .nullish();

const klipyItemSchema = z.object({
  slug: z.string().regex(/^[\w-]+$/),
  title: z.string().default(''),
  type: z.string().optional(),
  file: z.object({ hd: formatsSchema, md: formatsSchema, sm: formatsSchema, xs: formatsSchema }),
});
type KlipyItem = z.infer<typeof klipyItemSchema>;

const klipyPageSchema = z.object({
  data: z.object({
    data: z.array(z.unknown()).default([]),
    has_next: z.boolean().optional(),
  }),
});

type Formats = z.infer<typeof formatsSchema>;
/** WebP first: smaller than GIF and keeps sticker transparency. */
const pick = (...sizes: Formats[]) => {
  for (const size of sizes) {
    const file = size?.webp ?? size?.gif ?? size?.png;
    if (file && isKlipyMediaUrl(file.url)) return file;
  }
  return null;
};

export function toChatMedia(kind: ChatMediaKind, item: KlipyItem): ChatMedia | null {
  const { hd, md, sm, xs } = item.file;
  const main = pick(md, sm, hd, xs);
  if (!main) return null;
  const preview = pick(sm, xs, md) ?? main;
  return {
    kind,
    id: item.slug,
    title: item.title.slice(0, 200),
    url: main.url,
    previewUrl: preview.url,
    width: main.width,
    height: main.height,
  };
}

const cachedPageSchema = z.object({
  items: z.array(chatMediaSchema),
  nextPage: z.number().int().positive().nullable(),
});

export interface GifServiceDeps {
  redis: Redis;
  settings: Pick<SettingsService, 'get'>;
  /** Unset switches GIFs off. */
  apiKey: string | undefined;
  fetch?: typeof fetch;
}

/** GIF and sticker search from KLIPY, cached in Redis. The key never leaves the server. */
export function createGifService({
  redis,
  settings,
  apiKey,
  fetch: fetchImpl = fetch,
}: GifServiceDeps) {
  const itemKey = (kind: ChatMediaKind, id: string) => `gifs:item:${kind}:${id}`;

  function available(): boolean {
    return apiKey !== undefined && settings.get('features.gifs');
  }

  /** The key, or why GIFs can't be used right now. */
  function requireKey(): string {
    if (!settings.get('features.gifs')) {
      throw new GifError('gifs_disabled', 'GIFs are turned off');
    }
    if (apiKey === undefined) {
      throw new GifError('gifs_unavailable', 'GIFs are not set up on this server');
    }
    return apiKey;
  }

  async function call(path: string, params: Record<string, string>): Promise<unknown> {
    // The key is part of the path, so this URL must never be logged.
    const url = new URL(`${KLIPY_API}/${encodeURIComponent(requireKey())}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new GifError('gifs_unavailable', 'GIFs are unavailable right now');
    }
    if (res.status === 404) throw new GifError('gifs_not_found', 'That GIF was not found');
    if (!res.ok) throw new GifError('gifs_unavailable', 'GIFs are unavailable right now');
    return res.json().catch(() => null);
  }

  /** Content items of a KLIPY page, skipping ads and anything malformed. */
  function parsePage(kind: ChatMediaKind, body: unknown) {
    const page = klipyPageSchema.safeParse(body);
    if (!page.success) throw new GifError('gifs_unavailable', 'Unexpected GIF response');
    const items = page.data.data.data.flatMap((raw) => {
      const item = klipyItemSchema.safeParse(raw);
      if (!item.success || item.data.type === 'ad') return [];
      const media = toChatMedia(kind, item.data);
      return media ? [media] : [];
    });
    return { items, hasNext: page.data.data.has_next ?? false };
  }

  async function remember(items: ChatMedia[]) {
    if (items.length === 0) return;
    const pipeline = redis.pipeline();
    for (const m of items)
      pipeline.set(itemKey(m.kind, m.id), JSON.stringify(m), 'EX', ITEM_TTL_SEC);
    await pipeline.exec();
  }

  /** A page of GIFs or stickers for `q`, or trending ones when `q` is empty. */
  async function search(
    userId: string,
    kind: ChatMediaKind,
    rawQuery: string,
    page: number,
  ): Promise<GifSearchResponse> {
    requireKey();
    const q = rawQuery.trim().toLowerCase().replace(/\s+/g, ' ');
    const filter = settings.get('gifs.contentFilter');
    const cacheKey = `gifs:search:${kind}:${filter}:${q}:${page}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return cachedPageSchema.parse(JSON.parse(cached));
      } catch {
        // An unreadable entry is treated as a miss and overwritten below.
      }
    }
    const allowed = await hit(
      redis,
      `ratelimit:gifs:${userId}`,
      settings.get('limits.gifSearchesPerMinute'),
      60,
    );
    if (!allowed) throw new GifError('gifs_rate_limited', 'Slow down, try again in a minute');

    const path = q === '' ? `${kind}s/trending` : `${kind}s/search`;
    const params: Record<string, string> = {
      page: String(page),
      per_page: String(GIF_PAGE_SIZE),
      content_filter: filter,
    };
    if (q !== '') params.q = q;
    const { items, hasNext } = parsePage(kind, await call(path, params));
    const result: GifSearchResponse = { items, nextPage: hasNext ? page + 1 : null };
    await redis.set(cacheKey, JSON.stringify(result), 'EX', settings.get('gifs.cacheTtlSec'));
    await remember(items);
    return result;
  }

  /**
   * The server's own copy of a GIF or sticker, so a message can't point at an arbitrary URL.
   * Usually cached by the search that offered it; otherwise looked up once.
   */
  async function resolve(kind: ChatMediaKind, id: string): Promise<ChatMedia> {
    requireKey();
    const cached = await redis.get(itemKey(kind, id));
    if (cached) {
      try {
        return chatMediaSchema.parse(JSON.parse(cached));
      } catch {
        // Look it up again below.
      }
    }
    const { items } = parsePage(kind, await call(`${kind}s/items`, { slugs: id }));
    const media = items.find((m) => m.id === id);
    if (!media) throw new GifError('gifs_not_found', 'That GIF was not found');
    await remember([media]);
    return media;
  }

  return { available, search, resolve };
}

export type GifService = ReturnType<typeof createGifService>;
