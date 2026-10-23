import { Pause, Play, SkipForward, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { socket } from '@/lib/socket';
import { useRoomStore } from '@/stores/room';

/** Floating now-playing dock: shows the room's current track while a room page is open. */
export function PlayerDock() {
  const playback = useRoomStore((s) => s.playback);
  const members = useRoomStore((s) => s.members);
  const role = useRoomStore((s) => s.you?.role);
  const inRoom = useRoomStore((s) => s.status === 'joined');
  const canControl = role === 'host' || role === 'dj';
  const item = playback.item;
  const playing = playback.status === 'playing';

  if (!inRoom && !item) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="pointer-events-auto flex w-full max-w-2xl items-center gap-3 rounded-3xl border bg-card/90 p-2 pr-3 shadow-2xl shadow-black/50 ring-1 ring-volt/20 backdrop-blur">
        {item ? (
          <img
            src={item.track.thumbnailUrl}
            alt=""
            className="size-12 shrink-0 rounded-2xl object-cover ring-2 ring-volt"
          />
        ) : (
          <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-secondary ring-2 ring-volt">
            <span className="flex h-5 items-end gap-[3px]" aria-hidden>
              <i className="block h-3 w-[3px] animate-pulse rounded-full bg-volt" />
              <i className="block h-5 w-[3px] animate-pulse rounded-full bg-volt [animation-delay:150ms]" />
              <i className="block h-4 w-[3px] animate-pulse rounded-full bg-volt [animation-delay:300ms]" />
            </span>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {item ? item.track.title : 'Nothing playing yet'}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {item
              ? item.track.channelTitle
              : inRoom
                ? 'Paste a YouTube link to start'
                : 'Join a room to start listening'}
          </p>
        </div>
        <span className="hidden items-center gap-1 text-sm text-muted-foreground sm:flex">
          <Users className="size-3.5" /> {members.length}
        </span>
        <Button
          size="icon"
          aria-label={playing ? 'Pause' : 'Play'}
          disabled={!canControl || !item}
          className="rounded-full"
          onClick={() => socket.emit(playing ? 'playback:pause' : 'playback:play')}
        >
          {playing ? <Pause /> : <Play />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Skip"
          disabled={!canControl || !item}
          className="rounded-full"
          onClick={() => socket.emit('playback:skip')}
        >
          <SkipForward />
        </Button>
      </div>
    </div>
  );
}
