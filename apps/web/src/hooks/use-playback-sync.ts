import { useCallback, useEffect, useRef } from 'react';
import { expectedPositionMs } from '@spotibay/shared';
import type { PlayerControls } from '@/hooks/use-youtube-player';
import { timeSync } from '@/lib/clock';
import { socket } from '@/lib/socket';
import { PlayerState, UNAVAILABLE_ERROR_CODES } from '@/lib/youtube-iframe';
import { useRoomStore } from '@/stores/room';

/** A duration this far off the track's means the player is showing something else, such as an ad. */
const AD_DURATION_TOLERANCE_SEC = 2;

interface Options {
  controls: PlayerControls;
  ready: boolean;
  /** The listener has clicked "Join audio"; nothing plays before that. */
  joined: boolean;
}

/** Keeps the local YouTube player on the room's playback state (see "Sync algorithm" in PLAN.md). */
export function usePlaybackSync({ controls, ready, joined }: Options) {
  const version = useRoomStore((s) => s.playback.version);
  const checkIntervalMs = useRoomStore((s) => s.sync.checkIntervalMs);
  const loadedItemId = useRef<string | null>(null);
  const active = ready && joined;

  const expectedSeconds = () => {
    const { playback } = useRoomStore.getState();
    return expectedPositionMs(playback, timeSync.now()) / 1000;
  };

  /** Moves the player to the room's state; `force` also re-seeks when the drift is small. */
  const apply = useCallback(
    (force = false) => {
      const { playback, sync } = useRoomStore.getState();
      const item = playback.item;
      if (!item || playback.status === 'idle') {
        if (loadedItemId.current) controls.stop();
        loadedItemId.current = null;
        return;
      }
      const target = expectedSeconds();
      if (loadedItemId.current !== item.id) {
        loadedItemId.current = item.id;
        if (playback.status === 'playing') controls.load(item.track.videoId, target);
        else controls.cue(item.track.videoId, target);
        return;
      }
      if (playback.status === 'paused') {
        controls.pause();
        controls.seekTo(target);
        return;
      }
      const state = controls.state();
      if (state !== PlayerState.PLAYING && state !== PlayerState.BUFFERING) controls.play();
      if (force || Math.abs(controls.currentTime() - target) * 1000 > sync.driftThresholdMs) {
        controls.seekTo(target);
      }
    },
    [controls],
  );

  /** Drift correction. Skipped while buffering and while an ad seems to be playing. */
  const check = useCallback(() => {
    const { playback, sync } = useRoomStore.getState();
    if (
      playback.status !== 'playing' ||
      !playback.item ||
      loadedItemId.current !== playback.item.id
    ) {
      return;
    }
    const state = controls.state();
    if (
      state === PlayerState.PAUSED ||
      state === PlayerState.CUED ||
      state === PlayerState.UNSTARTED
    ) {
      controls.play();
      return;
    }
    if (state !== PlayerState.PLAYING) return;
    const duration = controls.duration();
    if (
      duration === 0 ||
      Math.abs(duration - playback.item.track.durationSec) > AD_DURATION_TOLERANCE_SEC
    ) {
      return;
    }
    if (Math.abs(controls.currentTime() - expectedSeconds()) * 1000 > sync.driftThresholdMs) {
      controls.seekTo(expectedSeconds());
    }
  }, [controls]);

  useEffect(() => {
    if (active) apply();
  }, [active, version, apply]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(check, checkIntervalMs);
    return () => clearInterval(id);
  }, [active, checkIntervalMs, check]);

  const onStateChange = useCallback(
    (state: number) => {
      // Back to playing after buffering or an ad: line up with the room again.
      if (state === PlayerState.PLAYING && active) check();
    },
    [active, check],
  );

  const onError = useCallback((code: number) => {
    const itemId = loadedItemId.current;
    if (itemId && UNAVAILABLE_ERROR_CODES.includes(code)) {
      socket.emit('playback:reportUnavailable', { queueItemId: itemId });
    }
  }, []);

  const resync = useCallback(() => apply(true), [apply]);

  return { onStateChange, onError, resync };
}
