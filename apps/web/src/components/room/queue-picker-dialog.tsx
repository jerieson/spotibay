import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { MAX_BATCH_VIDEOS, type Track } from '@spotibay/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLikes } from '@/hooks/use-likes';
import { fetchPlaylist } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { formatDuration } from '@/lib/format';
import { initialPicks, queueSlots, videosInRoom } from '@/lib/queue-slots';
import { socket } from '@/lib/socket';
import { cn } from '@/lib/utils';
import { useRoomStore } from '@/stores/room';

/** What the picker queues from: liked songs, or one of your playlists. */
export type PickerSource = { kind: 'likes' } | { kind: 'playlist'; id: string; name: string };

/** How many more songs you can queue right now, from the room as it stands. */
export function useQueueSlots(): number {
  const role = useRoomStore((s) => s.you?.role ?? 'listener');
  const userId = useRoomStore((s) => s.you?.userId ?? '');
  const limit = useRoomStore((s) => s.queueLimitPerUser);
  const queue = useRoomStore((s) => s.queue);
  const status = useRoomStore((s) => s.playback.status);
  return queueSlots({ role, userId, limit, queue, playback: { status } });
}

/**
 * Lets you choose which songs of a playlist (or your liked songs) to queue when they don't all
 * fit: under the per-person limit, or past the 50 songs one batch can hold.
 */
export function QueuePickerDialog({
  source,
  onOpenChange,
  onQueued,
}: {
  source: PickerSource | null;
  onOpenChange: (open: boolean) => void;
  onQueued?: () => void;
}) {
  return (
    <Dialog open={source !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col">
        {source?.kind === 'likes' && <LikesPicker onQueued={onQueued} />}
        {source?.kind === 'playlist' && (
          <PlaylistPicker id={source.id} name={source.name} onQueued={onQueued} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function LikesPicker({ onQueued }: { onQueued?: () => void }) {
  const likes = useLikes();
  if (likes.isLoading) return <Loading title="Liked songs" />;
  return <Picker title="Liked songs" tracks={likes.tracks} onQueued={onQueued} />;
}

function PlaylistPicker({
  id,
  name,
  onQueued,
}: {
  id: string;
  name: string;
  onQueued?: () => void;
}) {
  const playlist = useQuery({ queryKey: ['playlist', id], queryFn: () => fetchPlaylist(id) });
  if (playlist.isPending) return <Loading title={name} />;
  if (playlist.isError) {
    return (
      <DialogHeader>
        <DialogTitle>{name}</DialogTitle>
        <DialogDescription>{friendlyError(playlist.error)}</DialogDescription>
      </DialogHeader>
    );
  }
  return (
    <Picker title={name} tracks={playlist.data.items.map((i) => i.track)} onQueued={onQueued} />
  );
}

function Loading({ title }: { title: string }) {
  return (
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>Loading songs…</DialogDescription>
    </DialogHeader>
  );
}

function Picker({
  title,
  tracks,
  onQueued,
}: {
  title: string;
  tracks: Track[];
  onQueued?: () => void;
}) {
  const slots = useQueueSlots();
  const exempt = useRoomStore((s) => s.you?.role !== 'listener');
  const queue = useRoomStore((s) => s.queue);
  const playing = useRoomStore((s) => s.playback.item);
  const inRoom = videosInRoom(queue, playing);
  const [picks, setPicks] = useState<string[]>(() =>
    initialPicks(
      tracks.map((t) => t.videoId),
      inRoom,
      slots,
    ),
  );
  const full = picks.length >= slots;
  // The room can change while the picker is open (one of your songs plays, or someone else's).
  const tooMany = picks.length > slots;

  const toggle = (videoId: string) =>
    setPicks((p) => (p.includes(videoId) ? p.filter((id) => id !== videoId) : [...p, videoId]));

  function submit() {
    const chosen = new Set(picks);
    const videoIds = tracks.map((t) => t.videoId).filter((id) => chosen.has(id));
    socket.emit('queue:addMany', { videoIds: [...new Set(videoIds)] });
    onQueued?.();
  }

  let description: string;
  if (slots === 0) {
    description = 'You already have the most songs waiting. Add more once one of yours plays.';
  } else if (exempt) {
    description = `Pick up to ${MAX_BATCH_VIDEOS} songs to queue at once.`;
  } else {
    description = `You can add ${slots} more ${slots === 1 ? 'song' : 'songs'} right now. Pick which ones.`;
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="truncate pr-6">Queue from {title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span aria-live="polite" data-testid="picker-count">
          {picks.length} of {slots} picked
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          disabled={picks.length === 0}
          onClick={() => setPicks([])}
        >
          Clear
        </Button>
      </div>
      <ul className="-mx-1 min-h-0 flex-1 divide-y overflow-y-auto rounded-xl border">
        {tracks.map((track, index) => {
          const queued = inRoom.has(track.videoId);
          const picked = picks.includes(track.videoId);
          // A playlist can hold the same video twice; only its first row can be picked.
          const repeat = tracks.findIndex((t) => t.videoId === track.videoId) !== index;
          const disabled = queued || repeat || (!picked && full);
          return (
            <li key={`${track.videoId}-${index}`}>
              <label
                className={cn(
                  'flex items-center gap-3 p-2.5',
                  disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-muted/50',
                )}
              >
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-primary"
                  checked={picked && !repeat}
                  disabled={disabled}
                  onChange={() => toggle(track.videoId)}
                />
                <img
                  src={track.thumbnailUrl}
                  alt=""
                  className="size-10 shrink-0 rounded-md object-cover"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{track.title}</span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {queued
                      ? 'Already in the room'
                      : `${track.channelTitle} · ${formatDuration(track.durationSec * 1000)}`}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <DialogFooter>
        {tooMany && (
          <p className="text-sm text-destructive sm:mr-auto">
            Only {slots} fit now. Untick {picks.length - slots}.
          </p>
        )}
        <Button disabled={picks.length === 0 || tooMany} onClick={submit}>
          Queue {picks.length} {picks.length === 1 ? 'song' : 'songs'}
        </Button>
      </DialogFooter>
    </>
  );
}
