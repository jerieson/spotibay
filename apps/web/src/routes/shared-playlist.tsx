import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { LikeButton } from '@/components/library/like-button';
import { TrackRow } from '@/components/library/track-row';
import { Button } from '@/components/ui/button';
import { copySharedPlaylist, fetchSharedPlaylist } from '@/lib/api';

/** A playlist someone shared by link: read-only, with a button to copy it to your library. */
export function SharedPlaylistPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const playlist = useQuery({
    queryKey: ['shared-playlist', slug],
    queryFn: () => fetchSharedPlaylist(slug),
    retry: false,
  });
  const copy = useMutation({
    mutationFn: () => copySharedPlaylist(slug),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      toast(`Copied to your library`);
      void navigate(`/library/playlists/${p.id}`);
    },
    onError: (err) => toast.error(err.message),
  });

  if (playlist.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (playlist.isError) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-muted-foreground">
          This playlist doesn&apos;t exist, or its owner stopped sharing it.
        </p>
        <Button asChild variant="secondary">
          <Link to="/">Go home</Link>
        </Button>
      </div>
    );
  }

  const p = playlist.data;
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="font-display text-3xl font-extrabold tracking-tight">{p.name}</h1>
        <p className="text-sm text-muted-foreground">
          By {p.owner.displayName} · {p.itemCount} {p.itemCount === 1 ? 'track' : 'tracks'}
        </p>
        <div className="pt-2">
          {p.isOwner ? (
            <Button asChild variant="secondary">
              <Link to={`/library/playlists/${p.id}`}>Edit your playlist</Link>
            </Button>
          ) : (
            <Button onClick={() => copy.mutate()} disabled={copy.isPending}>
              <Copy /> {copy.isPending ? 'Copying…' : 'Copy to my library'}
            </Button>
          )}
        </div>
      </header>
      {p.items.length === 0 ? (
        <p className="rounded-2xl border bg-card p-4 text-sm text-muted-foreground">Empty.</p>
      ) : (
        <ol className="divide-y rounded-2xl border bg-card" aria-label="Tracks">
          {p.items.map((item) => (
            <li key={item.id}>
              <TrackRow track={item.track}>
                <LikeButton track={item.track} />
              </TrackRow>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
