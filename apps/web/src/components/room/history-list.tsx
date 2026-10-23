import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListPlus, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { UserAvatar } from '@/components/user-avatar';
import { Button } from '@/components/ui/button';
import { fetchRoomHistory, saveRoomHistory } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { socket } from '@/lib/socket';
import { useRoomStore } from '@/stores/room';

/** Tracks already played in this room. Refetches when the room moves on to another track. */
export function HistoryList({ code }: { code: string }) {
  const playingId = useRoomStore((s) => s.playback.item?.id ?? null);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => saveRoomHistory(code),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      toast.success(`Saved ${res.added} tracks as “${res.playlist.name}”`, {
        action: (
          <Link
            to={`/library/playlists/${res.playlist.id}`}
            className="ml-auto text-sm font-medium underline"
          >
            Open
          </Link>
        ),
      });
    },
    onError: (err) => toast.error(err.message),
  });
  const history = useQuery({
    queryKey: ['room-history', code, playingId],
    queryFn: () => fetchRoomHistory(code),
  });

  if (history.isPending) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (history.isError) {
    return (
      <p className="rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
        Couldn&apos;t load the history.
      </p>
    );
  }
  if (history.data.length === 0) {
    return (
      <p className="rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
        Nothing has finished playing yet.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <Button size="sm" variant="secondary" disabled={save.isPending} onClick={() => save.mutate()}>
        <ListPlus /> Save as playlist
      </Button>
      <ol className="divide-y rounded-2xl border bg-card" aria-label="Played in this room">
        {history.data.map((entry) => (
          <li key={entry.id} className="flex items-center gap-3 p-3" data-testid="history-item">
            <img
              src={entry.track.thumbnailUrl}
              alt=""
              className="size-10 shrink-0 rounded-md object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{entry.track.title}</p>
              <p className="truncate text-xs text-muted-foreground">
                {entry.track.channelTitle} · {formatDuration(entry.track.durationSec * 1000)}
              </p>
            </div>
            <UserAvatar
              avatar={entry.addedBy.avatar}
              name={`Added by ${entry.addedBy.displayName}`}
              className="size-6"
            />
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Add ${entry.track.title} again`}
              onClick={() => socket.emit('queue:add', { url: entry.track.videoId })}
            >
              <Plus /> Again
            </Button>
          </li>
        ))}
      </ol>
    </div>
  );
}
