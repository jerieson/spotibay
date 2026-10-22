import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { loadYouTubeApi, type YTPlayer } from '@/lib/youtube-iframe';

export interface PlayerHandlers {
  onStateChange?: (state: number) => void;
  onError?: (code: number) => void;
}

export interface PlayerControls {
  load(videoId: string, startSeconds: number): void;
  cue(videoId: string, startSeconds: number): void;
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(seconds: number): void;
  setVolume(volume: number): void;
  currentTime(): number;
  duration(): number;
  state(): number;
}

/**
 * Creates one IFrame player inside `containerRef` for as long as the component is mounted.
 * `ready` flips once the player accepts commands; `error` is set if the API could not load.
 */
export function useYouTubePlayer(
  containerRef: RefObject<HTMLElement | null>,
  handlers: PlayerHandlers,
) {
  const playerRef = useRef<YTPlayer | null>(null);
  const handlersRef = useRef(handlers);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    // The API swaps the element it is given for an iframe, so give it one we can throw away.
    const mount = document.createElement('div');
    container.appendChild(mount);

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return;
        playerRef.current = new YT.Player(mount, {
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0, controls: 0, disablekb: 1, modestbranding: 1 },
          events: {
            onReady: () => !cancelled && setReady(true),
            onStateChange: (e) => handlersRef.current.onStateChange?.(e.data),
            onError: (e) => handlersRef.current.onError?.(e.data),
          },
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Player failed to load');
      });

    return () => {
      cancelled = true;
      setReady(false);
      playerRef.current?.destroy();
      playerRef.current = null;
      container.replaceChildren();
    };
  }, [containerRef]);

  const controls = useMemo<PlayerControls>(() => {
    const p = () => playerRef.current;
    return {
      load: (videoId, startSeconds) => p()?.loadVideoById({ videoId, startSeconds }),
      cue: (videoId, startSeconds) => p()?.cueVideoById({ videoId, startSeconds }),
      play: () => p()?.playVideo(),
      pause: () => p()?.pauseVideo(),
      stop: () => p()?.stopVideo(),
      seekTo: (seconds) => p()?.seekTo(seconds, true),
      setVolume: (volume) => p()?.setVolume(volume),
      currentTime: () => p()?.getCurrentTime() ?? 0,
      duration: () => p()?.getDuration() ?? 0,
      state: () => p()?.getPlayerState() ?? -1,
    };
  }, []);

  return { ready, error, controls };
}
