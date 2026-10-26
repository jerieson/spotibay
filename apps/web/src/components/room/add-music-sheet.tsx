import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Link2, Loader2, Plus, Search } from 'lucide-react';
import { useState, type ComponentProps, type FormEvent } from 'react';
import {
  MIN_SUGGEST_QUERY_LENGTH,
  parseVideoId,
  type CatalogTrack,
  type Track,
} from '@spotibay/shared';
import { AddToPlaylistDialog } from '@/components/library/add-to-playlist-dialog';
import { LikeButton } from '@/components/library/like-button';
import { AddLinkForm } from '@/components/room/add-link-form';
import { LibraryQueue } from '@/components/room/library-queue';
import { TrackText } from '@/components/track-text';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { ApiError, resolveTrack, searchTracks, suggestTracks } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { socket } from '@/lib/socket';
import { cn } from '@/lib/utils';

const BUDGET_MESSAGE = 'Search is used up for today — paste a YouTube link instead';
const SUGGEST_DELAY_MS = 300;

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'search_budget_exhausted') return BUDGET_MESSAGE;
    return err.message;
  }
  return 'Search failed. Try again.';
}

/** A pasted YouTube link (not just a word that happens to look like a video id). */
const pastedVideoId = (text: string) => (/[./]/.test(text) ? parseVideoId(text) : null);

/** What the YouTube list below the search box is showing, if anything. */
type YouTubeList =
  | { kind: 'search'; results: Track[] }
  /** A suggested song had no confident match; these are the videos to pick from. */
  | { kind: 'fallback'; song: CatalogTrack; results: Track[] };

/**
 * The room's main action, in solid brand volt. While nothing is playing or queued it glows softly,
 * so a new room points people straight at it. The room page owns the sheet.
 */
export function AddMusicButton({
  className,
  attention = false,
  ...props
}: ComponentProps<typeof Button> & { attention?: boolean }) {
  return (
    <Button
      className={cn(
        'rounded-full bg-volt px-5 font-bold text-black shadow-md ring-1 shadow-volt/30 ring-black/10 transition hover:-translate-y-0.5 hover:bg-volt hover:shadow-lg hover:shadow-volt/40 active:translate-y-0',
        attention && 'attention-glow',
        className,
      )}
      {...props}
    >
      <Plus className="stroke-[3]" /> Add music
    </Button>
  );
}

export function AddMusicSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [youtube, setYoutube] = useState<YouTubeList | null>(null);
  const [showLink, setShowLink] = useState(false);

  const linkId = pastedVideoId(query.trim());
  const typed = useDebouncedValue(query.trim(), SUGGEST_DELAY_MS);
  const suggestions = useQuery({
    queryKey: ['suggest', typed.toLowerCase()],
    queryFn: () => suggestTracks(typed),
    enabled:
      open && youtube === null && !pastedVideoId(typed) && typed.length >= MIN_SUGGEST_QUERY_LENGTH,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const search = useMutation({
    mutationFn: searchTracks,
    onSuccess: (res) => setYoutube({ kind: 'search', results: res.results }),
  });

  const resolve = useMutation({
    mutationFn: (song: CatalogTrack) => resolveTrack(song.id),
    onSuccess: (res, song) => {
      if (res.status === 'matched') {
        socket.emit('queue:add', { url: res.track.videoId });
        setAdded((prev) => new Set(prev).add(song.id).add(res.track.videoId));
      } else {
        setYoutube({ kind: 'fallback', song, results: res.results });
      }
    },
  });

  function edit(value: string) {
    setQuery(value);
    // Typing again goes back to suggestions.
    setYoutube(null);
    search.reset();
    resolve.reset();
  }

  function addLink() {
    socket.emit('queue:add', { url: query.trim() });
    edit('');
    onOpenChange(false);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (linkId) addLink();
    else if (q) search.mutate(q);
  }

  function add(track: Track) {
    socket.emit('queue:add', { url: track.videoId });
    setAdded((prev) => new Set(prev).add(track.videoId));
  }

  const showSuggestions =
    youtube === null && !linkId && query.trim().length >= MIN_SUGGEST_QUERY_LENGTH;
  const songs = suggestions.data ?? [];
  const error = search.error ?? resolve.error;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-4 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Add music</SheetTitle>
          <SheetDescription>Search for a song, or queue from your library.</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-4">
          <form onSubmit={submit} className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => edit(e.target.value)}
              placeholder="Search for a song or artist"
              aria-label="Search for a song"
              maxLength={300}
              autoComplete="off"
              type="search"
              autoFocus
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={query.trim() === '' || search.isPending}
              title={linkId ? 'Add this link' : 'Search YouTube'}
            >
              {linkId ? <Plus /> : <Search />}
              <span className="hidden sm:inline">{linkId ? 'Add' : 'YouTube'}</span>
            </Button>
          </form>
          {linkId && (
            <button
              type="button"
              onClick={addLink}
              className="flex w-full items-center gap-3 rounded-xl border p-2 text-left hover:bg-accent"
            >
              <img
                src={`https://i.ytimg.com/vi/${linkId}/mqdefault.jpg`}
                alt=""
                className="h-12 w-20 shrink-0 rounded-md bg-muted object-cover"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Add this YouTube link</span>
                <span className="block truncate text-sm text-muted-foreground">{query.trim()}</span>
              </span>
              <Plus className="size-4 shrink-0" />
            </button>
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
                  <TrackText
                    title={track.title}
                    detail={`${track.channelTitle} · ${formatDuration(track.durationSec * 1000)}`}
                  />
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
          <section aria-label="YouTube link">
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0 text-muted-foreground"
              aria-expanded={showLink}
              onClick={() => setShowLink((v) => !v)}
            >
              <Link2 /> Have a YouTube link?
              <ChevronDown className={cn('transition-transform', showLink && 'rotate-180')} />
            </Button>
            {showLink && (
              <div className="mt-2">
                <AddLinkForm onAdded={() => onOpenChange(false)} />
              </div>
            )}
          </section>
          <section className="space-y-2" aria-label="From your library">
            <h3 className="text-sm font-semibold">From your library</h3>
            <LibraryQueue onQueued={() => onOpenChange(false)} />
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
      <TrackText
        title={song.title}
        detail={`${song.artist} · ${song.album} · ${formatDuration(song.durationSec * 1000)}`}
      />
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
