/** The slice of the YouTube IFrame Player API that Spotibay uses. */
export interface YTPlayer {
  loadVideoById(options: { videoId: string; startSeconds?: number }): void;
  cueVideoById(options: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setVolume(volume: number): void;
  destroy(): void;
}

export interface YTPlayerOptions {
  width: string;
  height: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: () => void;
    onStateChange?: (event: { data: number }) => void;
    onError?: (event: { data: number }) => void;
  };
}

export interface YTNamespace {
  Player: new (element: HTMLElement, options: YTPlayerOptions) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export const PlayerState = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

/** Error codes that mean this video cannot be played here. */
export const UNAVAILABLE_ERROR_CODES: readonly number[] = [2, 5, 100, 101, 150];

const SCRIPT_URL = 'https://www.youtube.com/iframe_api';
let loading: Promise<YTNamespace> | null = null;

/** Loads the IFrame API script once and resolves with its namespace. */
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  loading ??= new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error('YouTube player API did not load'));
    };
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error('Could not load the YouTube player'));
    };
    document.head.appendChild(script);
  });
  return loading;
}
