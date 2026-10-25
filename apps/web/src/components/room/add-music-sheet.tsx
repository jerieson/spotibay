import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Check, Loader2, Plus, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { MIN_SUGGEST_QUERY_LENGTH, type CatalogTrack, type Track } from '@spotibay/shared';
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
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { ApiError, resolveTrack, searchTracks, suggestTracks } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { socket } from '@/lib/socket';

const BUDGET_MESSAGE = 'Search is used up for today — paste a YouTube link instead';
const SUGGEST_DELAY_MS = 300;

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'search_budget_exhausted') return BUDGET_MESSAGE;
    return err.message;
  }
  return 'Search failed. Try again.';
}

/** What the YouTube list below the search box is showing, if anything. */
type YouTubeList =
  | { kind: 'search'; results: Track[] }
  /** A suggested song had no confident match; these are the videos to pick from. */
  | { kind: 'fallback'; song: CatalogTrack; results: Track[] };

export function AddMusicSheet() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [youtube, setYoutube] = useState<YouTubeList | null>(null);
  const [remaining, setRemaining] = useState<number>();

  const typed = useDebouncedValue(query.trim(), SUGGEST_DELAY_MS);
  const suggestions = useQuery({
    queryKey: ['suggest', typed.toLowerCase()],
    queryFn: () => suggestTracks(typed),
    enabled: open && youtube === null && typed.length >= MIN_SUGGEST_QUERY_LENGTH,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const search = useMutation({
    mutationFn: searchTracks,
    onSuccess: (res) => {
      setYoutube({ kind: 'search', results: res.results });
      setRemaining(res.remainingSearchesToday);
    },
  });

  const resolve = useMutation({
    mutationFn: (song: CatalogTrack) => resolveTrack(song.id),
    onSuccess: (res, song) => {
      setRemaining(res.remainingSearchesToday);
      if (res.status === 'matched') {
        socket.emit('queue:add', { url: res.track.videoId });
        setAdded((prev) => new Set(prev).add(song.id).add(res.track.videoId));
      } else {
        setYoutube({ kind: 'fallback', song, results: res.results });
      }
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q) search.mutate(q);
  }

  function edit(value: string) {
    setQuery(value);
    // Typing again goes back to suggestions.
    setYoutube(null);
    search.reset();
    resolve.reset();
  }

  function add(track: Track) {
    socket.emit('queue:add', { url: track.videoId });
    setAdded((prev) => new Set(prev).add(track.videoId));
  }

  const showSuggestions = youtube === null && query.trim().length >= MIN_SUGGEST_QUERY_LENGTH;
  const songs = suggestions.data ?? [];
  const error = search.error ?? resolve.error;

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
            Find a song, paste a YouTube link, or queue from your library.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-4">
          <AddLinkForm onAdded={() => setOpen(false)} />
          <form onSubmit={submit} className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => edit(e.target.value)}
              placeholder="Search for a song or artist"
              aria-label="Search for a song"
              maxLength={100}
              autoComplete="off"
              type="search"
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={query.trim() === '' || search.isPending}
              title="Search YouTube"
            >
              <Search /> <span className="hidden sm:inline">YouTube</span>
            </Button>
          </form>
          {remaining !== undefined && (
            <p className="text-sm text-muted-foreground">
              {remaining} YouTube {remaining === 1 ? 'search' : 'searches'} left today
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(error)}
            </p>
          )}

          {showSuggestions && (
            <section className="space-y-2" aria-label="Suggestions">
              {songs.length > 0 && (
                <ul className="divide-y rounded-xl border" aria-label="Suggested songs">
                  {songs.map((song) => (
                    <SuggestionRow
                      key={song.id}
                      song={song}
                      added={added.has(song.id)}
                      pending={resolve.isPending && resolve.variables?.id === song.id}
                      disabled={resolve.isPending}
                      onAdd={() => resolve.mutate(song)}
                    />
                  ))}
                </ul>
              )}
              {suggestions.isFetching && songs.length === 0 && (
                <p className="text-sm text-muted-foreground">Looking for songs…</p>
              )}
              {!suggestions.isFetching && suggestions.isSuccess && songs.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No songs found. Press Enter to search YouTube.
                </p>
              )}
              {suggestions.isError && (
                <p className="text-sm text-muted-foreground">
                  Suggestions aren't available. Press Enter to search YouTube.
                </p>
              )}
              {songs.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Song info from Deezer. Not here? Press Enter to search YouTube.
                </p>
              )}
            </section>
          )}

          {search.isPending && <p className="text-sm text-muted-foreground">Searching…</p>}
          {youtube?.kind === 'fallback' && (
            <p className="text-sm text-muted-foreground">
              Couldn't find an exact video for “{youtube.song.title}” by {youtube.song.artist}. Pick
              one:
            </p>
          )}
          {youtube && youtube.results.length === 0 && (
            <p className="text-sm text-muted-foreground">No playable results.</p>
          )}
          {youtube && youtube.results.length > 0 && (
            <ul className="divide-y rounded-xl border" aria-label="YouTube results">
              {youtube.results.map((track) => (
                <li key={track.videoId} className="flex items-center gap-3 p-2">
                  <img
                    src={track.thumbnailUrl}
                    alt=""
                    className="size-12 shrink-0 rounded-md object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{track.title}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {track.channelTitle} · {formatDuration(track.durationSec * 1000)}
                    </p>
                  </div>
                  <LikeButton track={track} />
                  <AddToPlaylistDialog track={track} />
                  <AddButton
                    label={track.title}
                    added={added.has(track.videoId)}
                    onClick={() => add(track)}
                  />
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

function SuggestionRow({
  song,
  added,
  pending,
  disabled,
  onAdd,
}: {
  song: CatalogTrack;
  added: boolean;
  pending: boolean;
  disabled: boolean;
  onAdd: () => void;
}) {
  return (
    <li className="flex items-center gap-3 p-2">
      {song.artworkUrl ? (
        <img src={song.artworkUrl} alt="" className="size-12 shrink-0 rounded-md object-cover" />
      ) : (
        <div className="size-12 shrink-0 rounded-md bg-muted" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{song.title}</p>
        <p className="truncate text-sm text-muted-foreground">
          {song.artist} · {song.album} · {formatDuration(song.durationSec * 1000)}
        </p>
      </div>
      <AddButton
        label={`${song.title} by ${song.artist}`}
        added={added}
        pending={pending}
        disabled={disabled}
        onClick={onAdd}
      />
    </li>
  );
}

function AddButton({
  label,
  added,
  pending = false,
  disabled = false,
  onClick,
}: {
  label: string;
  added: boolean;
  pending?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={onClick}
      disabled={added || disabled}
      aria-label={`Add ${label} to queue`}
    >
      {pending ? <Loader2 className="animate-spin" /> : added ? <Check /> : <Plus />}
      <span className="hidden sm:inline">{added ? 'Added' : 'Add'}</span>
    </Button>
  );
}
