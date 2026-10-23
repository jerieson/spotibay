import { Pause, Play, RefreshCw, SkipForward, ThumbsDown, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { expectedPositionMs } from '@spotibay/shared';
import { LikeButton } from '@/components/library/like-button';
import { ReactionLayer } from '@/components/room/reaction-layer';
import { UserAvatar } from '@/components/user-avatar';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { usePlaybackSync } from '@/hooks/use-playback-sync';
import { useYouTubePlayer, type PlayerHandlers } from '@/hooks/use-youtube-player';
import { timeSync } from '@/lib/clock';
import { formatDuration } from '@/lib/format';
import { socket } from '@/lib/socket';
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

  return (
    <section className="overflow-hidden rounded-2xl border bg-card" aria-label="Player">
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
        {!error && joined && !item && (
          <div className="absolute inset-0 grid place-items-center bg-background p-4 text-center text-sm text-muted-foreground">
            Nothing playing. Paste a YouTube link below to start.
          </div>
        )}
      </div>

      <div className="space-y-3 p-4">
        <div className="flex items-center gap-3">
          {item ? (
            <>
              <img
                src={item.track.thumbnailUrl}
                alt=""
                className="size-14 shrink-0 rounded-lg object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold" data-testid="now-playing-title">
                  {item.track.title}
                </p>
                <p className="truncate text-sm text-muted-foreground">{item.track.channelTitle}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                  Added by
                  <UserAvatar
                    avatar={item.addedBy.avatar}
                    name={item.addedBy.displayName}
                    className="size-4"
                  />
                  {item.addedBy.displayName}
                </p>
              </div>
            </>
          ) : (
            <p className="flex-1 text-sm text-muted-foreground">The room is quiet.</p>
          )}
          {item && <LikeButton track={item.track} />}
          {canControl && (
            <div className="flex shrink-0 gap-1">
              <Button
                size="icon"
                className="rounded-full"
                aria-label={playback.status === 'playing' ? 'Pause' : 'Play'}
                disabled={playback.status === 'idle'}
                onClick={() =>
                  socket.emit(playback.status === 'playing' ? 'playback:pause' : 'playback:play')
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
              className="flex-1"
            />
          ) : (
            <Progress
              value={durationMs ? Math.min(100, (shown / durationMs) * 100) : 0}
              aria-label="Track progress"
              className="h-2 flex-1"
            />
          )}
          <span className="w-10">{formatDuration(durationMs)}</span>
        </div>

        {item && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
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
              className="h-2 flex-1 [&>div]:bg-destructive"
            />
          </div>
        )}

        <div className="flex items-center gap-3">
          <Volume2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Slider
            min={1}
            max={100}
            value={[volume]}
            onValueChange={([v]) => setVolume(v ?? 1)}
            aria-label="Volume (only for you)"
            className="w-32"
          />
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            onClick={sync.resync}
            disabled={!joined || !item}
          >
            <RefreshCw /> Resync
          </Button>
        </div>
      </div>
    </section>
  );
}
