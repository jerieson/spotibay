import { useQuery } from '@tanstack/react-query';
import { Heart, ListMusic } from 'lucide-react';
import { MAX_BATCH_VIDEOS } from '@spotibay/shared';
import { Button } from '@/components/ui/button';
import { useLikes } from '@/hooks/use-likes';
import { fetchPlaylists } from '@/lib/api';
import { socket } from '@/lib/socket';

/** Queue a whole playlist, or your liked songs, into the room. */
export function LibraryQueue({ onQueued }: { onQueued?: () => void }) {
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: fetchPlaylists });
  const likes = useLikes();

  if (playlists.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const queueLikes = () => {
    socket.emit('queue:addMany', {
      videoIds: likes.tracks.slice(0, MAX_BATCH_VIDEOS).map((t) => t.videoId),
    });
    onQueued?.();
  };
  const empty = (playlists.data?.length ?? 0) === 0 && likes.tracks.length === 0;

  return (
    <div className="space-y-2">
      {empty && (
        <p className="text-sm text-muted-foreground">
          Your playlists and liked songs will show up here.
        </p>
      )}
      <ul className="divide-y rounded-xl border empty:hidden">
        {likes.tracks.length > 0 && (
          <li className="flex items-center gap-3 p-3">
            <Heart className="size-5 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">Liked songs</p>
              <p className="text-xs text-muted-foreground">
                {likes.tracks.length} {likes.tracks.length === 1 ? 'track' : 'tracks'}
                {likes.tracks.length > MAX_BATCH_VIDEOS && ` · latest ${MAX_BATCH_VIDEOS}`}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={queueLikes}>
              Queue
            </Button>
          </li>
        )}
        {playlists.data?.map((p) => (
          <li key={p.id} className="flex items-center gap-3 p-3">
            <ListMusic className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{p.name}</p>
              <p className="text-xs text-muted-foreground">
                {p.itemCount} {p.itemCount === 1 ? 'track' : 'tracks'}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={p.itemCount === 0}
              aria-label={`Queue ${p.name}`}
              onClick={() => {
                socket.emit('queue:addMany', { playlistId: p.id });
                onQueued?.();
              }}
            >
              Queue
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
