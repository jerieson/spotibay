import { Pause, SkipForward, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Floating now-playing dock. Static placeholder until playback lands in Phase 4. */
export function PlayerDock() {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-3">
      <div className="pointer-events-auto flex w-full max-w-2xl items-center gap-3 rounded-3xl border bg-card/90 p-2 pr-3 shadow-2xl shadow-black/50 ring-1 ring-volt/20 backdrop-blur">
        <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-secondary ring-2 ring-volt">
          <span className="flex h-5 items-end gap-[3px]" aria-hidden>
            <i className="block h-3 w-[3px] animate-pulse rounded-full bg-volt" />
            <i className="block h-5 w-[3px] animate-pulse rounded-full bg-volt [animation-delay:150ms]" />
            <i className="block h-4 w-[3px] animate-pulse rounded-full bg-volt [animation-delay:300ms]" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">Nothing playing yet</p>
          <p className="truncate text-xs text-muted-foreground">Join a room to start listening</p>
        </div>
        <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
          <Users className="size-3.5" /> 0
        </span>
        <Button size="icon" aria-label="Play or pause" disabled className="rounded-full">
          <Pause />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Skip" disabled className="rounded-full">
          <SkipForward />
        </Button>
      </div>
    </div>
  );
}
