import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { catalogTrackSchema, type CatalogTrack } from '@spotibay/shared';
import { resolveTrack } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { socket } from '@/lib/socket';

/** Router state of a room opened to play a song picked elsewhere (a home page suggestion). */
export interface QueueSongState {
  queueSong: CatalogTrack;
}

/**
 * Queues the song the room was opened with, once joined. The state is cleared first, so going
 * back or reloading doesn't queue it again.
 */
export function useQueueSongOnJoin(joined: boolean) {
  const location = useLocation();
  const navigate = useNavigate();
  const done = useRef(false);
  const state: unknown = location.state;

  useEffect(() => {
    if (!joined || done.current) return;
    const parsed = catalogTrackSchema.safeParse(
      state && typeof state === 'object' && 'queueSong' in state ? state.queueSong : null,
    );
    if (!parsed.success) return;
    done.current = true;
    const song = parsed.data;
    void navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    resolveTrack(song.id)
      .then((res) => {
        if (res.status === 'matched') socket.emit('queue:add', { url: res.track.videoId });
        else toast(`Couldn't find a video for “${song.title}”. Search for it in Add music.`);
      })
      .catch((err: unknown) => toast.error(friendlyError(err)));
  }, [joined, state, navigate, location.pathname, location.search]);
}
