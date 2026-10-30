import { useInfiniteQuery } from '@tanstack/react-query';
import { ImagePlay, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { ChatMedia, ChatMediaKind } from '@spotibay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { searchGifs } from '@/lib/api';
import { cn } from '@/lib/utils';
import { friendlyError } from '@/lib/errors';

const SEARCH_DELAY_MS = 300;

/** GIF and sticker search; picking one sends it straight away. */
export function GifPicker({ onPick }: { onPick: (media: ChatMedia) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ChatMediaKind>('gif');
  const [query, setQuery] = useState('');
  const q = useDebouncedValue(query.trim(), SEARCH_DELAY_MS);

  const results = useInfiniteQuery({
    queryKey: ['gifs', kind, q.toLowerCase()],
    queryFn: ({ pageParam }) => searchGifs(kind, q, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage ?? undefined,
    enabled: open,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const items = results.data?.pages.flatMap((p) => p.items) ?? [];

  function pick(media: ChatMedia) {
    onPick(media);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label="GIFs and stickers">
          <ImagePlay />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[min(22rem,calc(100vw-2rem))] p-2">
        <Tabs value={kind} onValueChange={(v) => setKind(v as ChatMediaKind)}>
          <TabsList className="mb-2 w-full">
            <TabsTrigger value="gif">GIFs</TabsTrigger>
            <TabsTrigger value="sticker">Stickers</TabsTrigger>
          </TabsList>
        </Tabs>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={kind === 'gif' ? 'Search GIFs' : 'Search stickers'}
          aria-label={kind === 'gif' ? 'Search GIFs' : 'Search stickers'}
          maxLength={100}
          autoComplete="off"
          type="search"
          autoFocus
        />
        <div className="mt-2 h-72 overflow-y-auto">
          {results.isPending && (
            <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          )}
          {results.isError && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {friendlyError(results.error)}
            </p>
          )}
          {results.isSuccess && items.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">Nothing found.</p>
          )}
          <div className="grid grid-cols-3 gap-1.5">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => pick(item)}
                className={cn(
                  'aspect-square overflow-hidden rounded-md outline-none hover:ring-2 hover:ring-volt focus-visible:ring-2 focus-visible:ring-ring',
                  item.kind === 'gif' && 'bg-muted',
                )}
                title={item.title || undefined}
              >
                <img
                  src={item.previewUrl}
                  alt={item.title || (item.kind === 'gif' ? 'GIF' : 'Sticker')}
                  loading="lazy"
                  className={cn(
                    'size-full',
                    item.kind === 'gif' ? 'object-cover' : 'object-contain',
                  )}
                />
              </button>
            ))}
          </div>
          {results.hasNextPage && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 w-full"
              disabled={results.isFetchingNextPage}
              onClick={() => void results.fetchNextPage()}
            >
              {results.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </div>
        <p className="mt-2 text-right text-xs text-muted-foreground">
          Powered by{' '}
          <a
            href="https://klipy.com"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold hover:underline"
          >
            KLIPY
          </a>
        </p>
      </PopoverContent>
    </Popover>
  );
}
