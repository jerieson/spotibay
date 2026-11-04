import { useQuery } from '@tanstack/react-query';
import { Heart, ListMusic } from 'lucide-react';
import { useState } from 'react';
import type { PlaylistSummary } from '@spotibay/shared';
import {
  QueuePickerDialog,
  useQueueSlots,
  type PickerSource,
} from '@/components/room/queue-picker-dialog';
import { TrackText } from '@/components/track-text';
import { Button } from '@/components/ui/button';
import { useLikes } from '@/hooks/use-likes';
import { fetchPlaylists } from '@/lib/api';
import { socket } from '@/lib/socket';
import { useRoomStore } from '@/stores/room';

/**
 * Queue a playlist, or your liked songs, into the room. When they don't all fit (the per-person
 * limit, or more than one batch of liked songs), a picker asks which ones.
 */
export function LibraryQueue({ onQueued }: { onQueued?: () => void }) {
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: fetchPlaylists });
  const likes = useLikes();
  const slots = useQueueSlots();
  const exempt = useRoomStore((s) => s.you?.role !== 'listener');
  const [picking, setPicking] = useState<PickerSource | null>(null);

  if (playlists.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const queueLikes = () => {
    if (likes.tracks.length > slots) return setPicking({ kind: 'likes' });
    socket.emit('queue:addMany', { videoIds: likes.tracks.map((t) => t.videoId) });
    onQueued?.();
  };
  // The host and DJs queue a whole playlist (the room limit still applies on the server).
  const queuePlaylist = (p: PlaylistSummary) => {
    if (!exempt && p.itemCount > slots) {
      return setPicking({ kind: 'playlist', id: p.id, name: p.name });
    }
    socket.emit('queue:addMany', { playlistId: p.id });
    onQueued?.();
  };
  const queuedFromPicker = () => {
    setPicking(null);
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
              <p className="text-sm text-muted-foreground">
                {likes.tracks.length} {likes.tracks.length === 1 ? 'track' : 'tracks'}
                {likes.tracks.length > slots && ' · choose which'}
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
            <TrackText
              title={p.name}
              detail={`${p.itemCount} ${p.itemCount === 1 ? 'track' : 'tracks'}${
                !exempt && p.itemCount > slots ? ' · choose which' : ''
              }`}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={p.itemCount === 0}
              aria-label={`Queue ${p.name}`}
              onClick={() => queuePlaylist(p)}
            >
              Queue
            </Button>
          </li>
        ))}
      </ul>
      <QueuePickerDialog
        source={picking}
        onOpenChange={(open) => !open && setPicking(null)}
        onQueued={queuedFromPicker}
      />
    </div>
  );
}
