import { useQuery } from '@tanstack/react-query';
import {
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  SkipForward,
  ThumbsDown,
  Volume2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { expectedPositionMs, VIBES, type VibeId } from '@spotibay/shared';
import { toast } from 'sonner';
import { LikeButton } from '@/components/library/like-button';
import { ReactionBar } from '@/components/room/reaction-bar';
import { ReactionLayer } from '@/components/room/reaction-layer';
import { UserAvatar } from '@/components/user-avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { usePlaybackSync } from '@/hooks/use-playback-sync';
import { useQueueCatalogSong } from '@/hooks/use-queue-catalog-song';
import { useYouTubePlayer, type PlayerHandlers } from '@/hooks/use-youtube-player';
import { fetchVibe } from '@/lib/api';
import { timeSync } from '@/lib/clock';
import { formatDuration } from '@/lib/format';
import { socket } from '@/lib/socket';
import { cn } from '@/lib/utils';
import { useRoomStore } from '@/stores/room';

const VOLUME_KEY = 'spotibay.volume';

function readVolume(): number {
  try {
    const stored = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(stored) && stored >= 0 && stored <= 100 && stored !== 0 ? stored : 80;
  } catch {
    return 80;
  }
}

/** Server-synced playback position, refreshed a few times a second. */
export function usePosition(): number {
  const playback = useRoomStore((s) => s.playback);
  const [position, setPosition] = useState(() => expectedPositionMs(playback, timeSync.now()));
  useEffect(() => {
    const tick = () => setPosition(expectedPositionMs(playback, timeSync.now()));
    tick();
    if (playback.status !== 'playing') return;
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [playback]);
  return position;
}

export function PlayerPanel() {
  const playback = useRoomStore((s) => s.playback);
  const role = useRoomStore((s) => s.you?.role);
  const canControl = role === 'host' || role === 'dj';
  const selfId = useRoomStore((s) => s.you?.userId);
  const skipVotes = useRoomStore((s) => s.skipVotes);
  const votedSkip = selfId !== undefined && skipVotes.voters.includes(selfId);
  const containerRef = useRef<HTMLDivElement>(null);
  const handlers = useRef<PlayerHandlers>({});
  const { ready, error, controls } = useYouTubePlayer(containerRef, {
    onStateChange: (s) => handlers.current.onStateChange?.(s),
    onError: (c) => handlers.current.onError?.(c),
  });
  const [joined, setJoined] = useState(false);
  const [volume, setVolume] = useState(readVolume);
  const sync = usePlaybackSync({ controls, ready, joined });
  const position = usePosition();
  const [scrub, setScrub] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const setPlayerVisible = useRoomStore((s) => s.setPlayerVisible);

  // The floating dock only shows once the big player is mostly off screen.
  useEffect(() => {
    const el = panelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    // Many thresholds so it re-checks as the panel grows or shrinks (songs queued, the empty
    // state going away); "visible" means a good part of it is on screen.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const shown = entry.intersectionRect.height;
        setPlayerVisible(shown >= Math.min(240, entry.boundingClientRect.height * 0.35));
      },
      { threshold: Array.from({ length: 11 }, (_, i) => i / 10) },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      setPlayerVisible(false);
    };
  }, [setPlayerVisible]);

  useEffect(() => {
    handlers.current = { onStateChange: sync.onStateChange, onError: sync.onError };
  });

  useEffect(() => {
    if (ready) controls.setVolume(volume);
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {
      // Storage can be unavailable; the volume just won't be remembered.
    }
  }, [ready, controls, volume]);

  const item = playback.item;
  const durationMs = (item?.track.durationSec ?? 0) * 1000;
  const shown = scrub ?? position;
  const commitScrub = () => {
    if (scrub !== null) socket.emit('playback:seek', { positionMs: Math.round(scrub) });
    setScrub(null);
  };

  const idle = !item;
  const artwork = item?.track.thumbnailUrl;

  return (
    <div ref={panelRef} className="relative isolate">
      {/* The artwork, blurred and spread wide, as a glow behind the player. */}
      {artwork && (
        <div
          key={artwork}
          aria-hidden
          className="pointer-events-none absolute -inset-6 -z-10 animate-in bg-cover bg-center opacity-40 blur-3xl duration-1000 fade-in motion-reduce:animate-none dark:opacity-30"
          style={{ backgroundImage: `url("${artwork}")` }}
        />
      )}
      <section
        className="overflow-hidden rounded-2xl border bg-card/90 backdrop-blur"
        aria-label="Player"
      >
        <div className="relative aspect-video bg-black">
          <div ref={containerRef} className="absolute inset-0 [&_iframe]:size-full" />
          <ReactionLayer />
          {error && (
            <p className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-white">
              {error}
            </p>
          )}
          {!error && !joined && (
            <div className="absolute inset-0 grid place-items-center bg-background/85 p-4 backdrop-blur-sm">
              <Button size="lg" onClick={() => setJoined(true)} disabled={!ready}>
                <Volume2 /> {ready ? 'Join audio' : 'Loading player…'}
              </Button>
            </div>
          )}
          {!error && joined && idle && <EmptyRoom />}
        </div>

        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            {item ? (
              <>
                <img
                  src={item.track.thumbnailUrl}
                  alt=""
                  className="size-12 shrink-0 rounded-lg object-cover sm:size-14"
                />
                <div className="min-w-[11rem] flex-1">
                  <p
                    className="line-clamp-2 leading-snug font-semibold break-words sm:line-clamp-1"
                    data-testid="now-playing-title"
                  >
                    {item.track.title}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    {item.track.channelTitle}
                  </p>
                  {item.source === 'autoplay' ? (
                    <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                      <Radio className="size-3.5 shrink-0" />
                      <span className="truncate">Picked by autoplay</span>
                    </p>
                  ) : (
                    <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                      <span className="shrink-0">Added by</span>
                      <UserAvatar
                        avatar={item.addedBy.avatar}
                        name={item.addedBy.displayName}
                        className="size-4 shrink-0"
                      />
                      <span className="truncate">{item.addedBy.displayName}</span>
                    </p>
                  )}
                </div>
              </>
            ) : (
              <p className="flex-1 text-sm text-muted-foreground">The room is quiet.</p>
            )}
            {/* On narrow screens these move to their own line rather than squeeze the title. */}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {item && <LikeButton track={item.track} />}
              {canControl && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="icon"
                    variant={idle ? 'secondary' : 'default'}
                    className={cn(
                      'rounded-full',
                      !idle &&
                        'bg-[var(--room-accent)] text-[var(--room-accent-ink)] transition-colors duration-700 hover:bg-[var(--room-accent)]/90',
                    )}
                    aria-label={playback.status === 'playing' ? 'Pause' : 'Play'}
                    disabled={playback.status === 'idle'}
                    onClick={() =>
                      socket.emit(
                        playback.status === 'playing' ? 'playback:pause' : 'playback:play',
                      )
                    }
                  >
                    {playback.status === 'playing' ? <Pause /> : <Play />}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="rounded-full"
                    aria-label="Skip"
                    disabled={!item}
                    onClick={() => socket.emit('playback:skip')}
                  >
                    <SkipForward />
                  </Button>
                </div>
              )}
              <PlayerMenu onResync={sync.resync} canResync={joined && !!item} />
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm tabular-nums text-muted-foreground">
            <span className="w-10 text-right">{formatDuration(shown)}</span>
            {canControl && item ? (
              <Slider
                min={0}
                max={durationMs}
                step={1000}
                value={[Math.min(shown, durationMs)]}
                onValueChange={([v]) => setScrub(v ?? 0)}
                onValueCommit={commitScrub}
                aria-label="Seek"
                className="flex-1 [&_[data-slot=slider-range]]:bg-[var(--room-accent)] [&_[data-slot=slider-range]]:transition-colors [&_[data-slot=slider-range]]:duration-700"
              />
            ) : (
              <Progress
                value={durationMs ? Math.min(100, (shown / durationMs) * 100) : 0}
                aria-label="Track progress"
                className="h-2 flex-1"
                indicatorClassName={
                  idle ? 'bg-muted-foreground/30' : 'bg-[var(--room-accent)] duration-700'
                }
              />
            )}
            <span className="w-10">{formatDuration(durationMs)}</span>
          </div>

          {/* Hosts and DJs skip directly; everyone else votes. */}
          {item && !canControl && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
              <Button
                size="sm"
                variant={votedSkip ? 'default' : 'secondary'}
                disabled={votedSkip}
                onClick={() => socket.emit('playback:voteSkip')}
              >
                <ThumbsDown /> {votedSkip ? 'Voted to skip' : 'Vote skip'}
              </Button>
              <span data-testid="skip-votes">
                {skipVotes.voters.length} of {skipVotes.needed} needed
              </span>
              <Progress
                value={Math.min(100, (skipVotes.voters.length / skipVotes.needed) * 100)}
                aria-label="Skip votes"
                className="h-2 min-w-16 flex-1 [&>div]:bg-destructive"
              />
            </div>
          )}

          <div className="flex items-center gap-2 sm:gap-3">
            <Volume2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <Slider
              min={1}
              max={100}
              value={[volume]}
              onValueChange={([v]) => setVolume(v ?? 1)}
              aria-label="Volume (only for you)"
              className="min-w-16 flex-1 sm:w-24 sm:flex-none lg:w-28 [&_[data-slot=slider-range]]:bg-[var(--room-accent)] [&_[data-slot=slider-range]]:transition-colors [&_[data-slot=slider-range]]:duration-700"
            />
            <ReactionBar />
          </div>

          <UpNext />
        </div>
      </section>
    </div>
  );
}

/** Less-used actions, out of the main row. */
function PlayerMenu({ onResync, canResync }: { onResync: () => void; canResync: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="shrink-0 rounded-full" aria-label="More">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!canResync} onSelect={onResync}>
          <RefreshCw /> Resync with the room
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The next few songs, so nobody has to open the Queue tab to see what's coming. */
function UpNext() {
  const queue = useRoomStore((s) => s.queue);
  const setTab = useRoomStore((s) => s.setTab);
  if (queue.length === 0) return null;
  return (
    <div className="border-t pt-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Up next
        </p>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => setTab('queue')}
        >
          See all{queue.length > 3 ? ` (${queue.length})` : ''}
        </Button>
      </div>
      <ol className="space-y-2">
        {queue.slice(0, 3).map((q) => (
          <li key={q.id} className="flex min-w-0 items-center gap-3">
            <img
              src={q.track.thumbnailUrl}
              alt=""
              className="size-9 shrink-0 rounded-md object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{q.track.title}</p>
              <p className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
                {q.source === 'autoplay' ? (
                  <>
                    <Radio className="size-3 shrink-0" /> Picked by autoplay
                  </>
                ) : (
                  <>Added by {q.addedBy.displayName}</>
                )}
              </p>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatDuration(q.track.durationSec * 1000)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A quiet room: one big way in, plus moods to start from with a tap. */
function EmptyRoom() {
  const setAddingMusic = useRoomStore((s) => s.setAddingMusic);
  const [vibeId, setVibeId] = useState<VibeId | null>(null);
  const songs = useQuery({
    queryKey: ['vibe', vibeId],
    queryFn: () => fetchVibe(vibeId!),
    enabled: vibeId !== null,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
  const queueSong = useQueueCatalogSong({
    onMatched: (song) => toast.success(`Queued ${song.title}`),
    onNoMatch: (song) => {
      toast(`No exact video for ${song.title}. Search for it here.`);
      setAddingMusic(true);
    },
  });

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 overflow-y-auto bg-background p-4 text-center">
      <div>
        <p className="font-display text-lg font-bold">Nothing playing</p>
        <p className="text-sm text-muted-foreground">Add a song, or start from a vibe.</p>
      </div>
      <Button size="lg" className="rounded-full" onClick={() => setAddingMusic(true)}>
        <Plus /> Add music
      </Button>
      <div className="flex max-w-lg flex-wrap justify-center gap-2" aria-label="Vibes">
        {VIBES.map((v) => (
          <Button
            key={v.id}
            size="sm"
            variant={v.id === vibeId ? 'default' : 'outline'}
            className="rounded-full"
            aria-pressed={v.id === vibeId}
            onClick={() => setVibeId(v.id === vibeId ? null : v.id)}
          >
            {v.name}
          </Button>
        ))}
      </div>
      {vibeId && songs.isPending && <p className="text-xs text-muted-foreground">Loading songs…</p>}
      {songs.data && vibeId && (
        <ul className="flex w-full max-w-full gap-2 overflow-x-auto pb-1" aria-label="Vibe songs">
          {songs.data.suggestions.slice(0, 12).map((s) => (
            <li key={s.id} className="w-24 shrink-0">
              <button
                type="button"
                className="w-full rounded-xl p-1 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
                disabled={queueSong.isPending}
                onClick={() => queueSong.mutate(s)}
                aria-label={`Queue ${s.title} by ${s.artist}`}
              >
                {s.artworkUrl ? (
                  <img
                    src={s.artworkUrl}
                    alt=""
                    className="aspect-square w-full rounded-lg object-cover"
                  />
                ) : (
                  <div className="aspect-square w-full rounded-lg bg-muted" />
                )}
                <span className="mt-1 block truncate text-xs font-medium">{s.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{s.artist}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
