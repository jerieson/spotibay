import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListMusic, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ImportPlaylistDialog } from '@/components/library/import-playlist-dialog';
import { LikeButton } from '@/components/library/like-button';
import { TrackRow } from '@/components/library/track-row';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLikes } from '@/hooks/use-likes';
import { createPlaylist, fetchListenHistory, fetchPlaylists } from '@/lib/api';

export function LibraryPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="font-display text-3xl font-extrabold tracking-tight">Your library</h1>
      <Tabs defaultValue="playlists">
        <TabsList>
          <TabsTrigger value="playlists">Playlists</TabsTrigger>
          <TabsTrigger value="liked">Liked songs</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="playlists" className="space-y-4">
          <PlaylistsTab />
        </TabsContent>
        <TabsContent value="liked">
          <LikedTab />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PlaylistsTab() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: fetchPlaylists });
  const create = useMutation({
    mutationFn: createPlaylist,
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      setName('');
      void navigate(`/library/playlists/${p.id}`);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) create.mutate(name.trim());
  }

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row">
        <form onSubmit={submit} className="flex flex-1 gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New playlist name"
            aria-label="New playlist name"
            maxLength={60}
            autoComplete="off"
          />
          <Button type="submit" disabled={name.trim() === '' || create.isPending}>
            <Plus /> Create
          </Button>
        </form>
        <ImportPlaylistDialog />
      </div>
      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          {create.error.message}
        </p>
      )}
      {playlists.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {playlists.isError && (
        <p role="alert" className="text-sm text-destructive">
          Couldn&apos;t load your playlists.
        </p>
      )}
      {playlists.data?.length === 0 && (
        <p className="rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
          No playlists yet. Create one, import one from YouTube, or add songs from search in a room.
        </p>
      )}
      <ul className="grid gap-3 sm:grid-cols-2">
        {playlists.data?.map((p) => (
          <li key={p.id}>
            <Link
              to={`/library/playlists/${p.id}`}
              className="flex items-center gap-3 rounded-2xl border bg-card p-3 transition-colors hover:border-ring/60"
            >
              {p.thumbnailUrl ? (
                <img
                  src={p.thumbnailUrl}
                  alt=""
                  className="size-14 shrink-0 rounded-lg object-cover"
                />
              ) : (
                <div className="grid size-14 shrink-0 place-items-center rounded-lg bg-secondary">
                  <ListMusic className="size-6 text-muted-foreground" />
                </div>
              )}
              <div className="min-w-0">
                <p className="truncate font-semibold">{p.name}</p>
                <p className="text-sm text-muted-foreground">
                  {p.itemCount} {p.itemCount === 1 ? 'track' : 'tracks'} ·{' '}
                  {p.isPublic ? 'Shared' : 'Private'}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function LikedTab() {
  const { tracks, isLoading } = useLikes();
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (tracks.length === 0) {
    return (
      <p className="rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
        Tap the heart on a song to keep it here.
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-2xl border bg-card" aria-label="Liked songs">
      {tracks.map((track) => (
        <li key={track.videoId}>
          <TrackRow track={track}>
            <LikeButton track={track} />
          </TrackRow>
        </li>
      ))}
    </ul>
  );
}

function HistoryTab() {
  const history = useInfiniteQuery({
    queryKey: ['listen-history'],
    queryFn: ({ pageParam }) => fetchListenHistory(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const entries = history.data?.pages.flatMap((p) => p.entries) ?? [];

  if (history.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (history.isError) {
    return <p className="text-sm text-destructive">Couldn&apos;t load your history.</p>;
  }
  if (entries.length === 0) {
    return (
      <p className="rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
        Songs you listen to in rooms show up here.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <ol className="divide-y rounded-2xl border bg-card" aria-label="Listening history">
        {entries.map((entry) => (
          <li key={entry.id}>
            <TrackRow track={entry.track}>
              <time
                className="shrink-0 text-sm text-muted-foreground"
                dateTime={entry.playedAt}
                title={new Date(entry.playedAt).toLocaleString()}
              >
                {new Date(entry.playedAt).toLocaleDateString()}
              </time>
              <LikeButton track={entry.track} />
            </TrackRow>
          </li>
        ))}
      </ol>
      {history.hasNextPage && (
        <Button
          variant="secondary"
          className="w-full"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
