import { useMutation } from '@tanstack/react-query';
import { Check, Plus, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { Track } from '@spotibay/shared';
import { AddToPlaylistDialog } from '@/components/library/add-to-playlist-dialog';
import { LikeButton } from '@/components/library/like-button';
import { AddLinkForm } from '@/components/room/add-link-form';
import { LibraryQueue } from '@/components/room/library-queue';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { ApiError, searchTracks } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { socket } from '@/lib/socket';

const BUDGET_MESSAGE = 'Search is used up for today — paste a YouTube link instead';

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'search_budget_exhausted') return BUDGET_MESSAGE;
    return err.message;
  }
  return 'Search failed. Try again.';
}

export function AddMusicSheet() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const search = useMutation({ mutationFn: searchTracks });

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q) search.mutate(q);
  }

  function add(track: Track) {
    socket.emit('queue:add', { url: track.videoId });
    setAdded((prev) => new Set(prev).add(track.videoId));
  }

  const remaining = search.data?.remainingSearchesToday;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button className="w-full sm:w-auto">
          <Plus /> Add music
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-4 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Add music</SheetTitle>
          <SheetDescription>
            Search YouTube, paste a link, or queue from your library.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-4">
          <AddLinkForm onAdded={() => setOpen(false)} />
          <form onSubmit={submit} className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for a song"
              aria-label="Search YouTube"
              maxLength={100}
              autoComplete="off"
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={query.trim() === '' || search.isPending}
            >
              <Search /> Search
            </Button>
          </form>
          {remaining !== undefined && (
            <p className="text-xs text-muted-foreground">
              {remaining} {remaining === 1 ? 'search' : 'searches'} left today
            </p>
          )}
          {search.isPending && <p className="text-sm text-muted-foreground">Searching…</p>}
          {search.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(search.error)}
            </p>
          )}
          {search.data && search.data.results.length === 0 && (
            <p className="text-sm text-muted-foreground">No playable results.</p>
          )}
          {search.data && search.data.results.length > 0 && (
            <ul className="divide-y rounded-xl border" aria-label="Search results">
              {search.data.results.map((track) => (
                <li key={track.videoId} className="flex items-center gap-3 p-2">
                  <img
                    src={track.thumbnailUrl}
                    alt=""
                    className="size-12 shrink-0 rounded-md object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{track.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {track.channelTitle} · {formatDuration(track.durationSec * 1000)}
                    </p>
                  </div>
                  <LikeButton track={track} />
                  <AddToPlaylistDialog track={track} />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => add(track)}
                    disabled={added.has(track.videoId)}
                    aria-label={`Add ${track.title} to queue`}
                  >
                    {added.has(track.videoId) ? <Check /> : <Plus />}
                    {added.has(track.videoId) ? 'Added' : 'Add'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <section className="space-y-2" aria-label="From your library">
            <h3 className="text-sm font-semibold">From your library</h3>
            <LibraryQueue onQueued={() => setOpen(false)} />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
