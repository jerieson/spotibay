import { useMutation } from '@tanstack/react-query';
import type { CatalogTrack, Track } from '@spotibay/shared';
import { resolveTrack } from '@/lib/api';
import { socket } from '@/lib/socket';

/**
 * Queues a catalog (Deezer) song: finds its video (free when someone matched it before), then
 * adds it. When no video is confidently it, `onNoMatch` gets YouTube's results to pick from.
 */
export function useQueueCatalogSong({
  onMatched,
  onNoMatch,
}: {
  onMatched?: (song: CatalogTrack, track: Track) => void;
  onNoMatch?: (song: CatalogTrack, results: Track[]) => void;
} = {}) {
  return useMutation({
    mutationFn: (song: CatalogTrack) => resolveTrack(song.id),
    onSuccess: (res, song) => {
      if (res.status === 'matched') {
        socket.emit('queue:add', { url: res.track.videoId });
        onMatched?.(song, res.track);
      } else {
        onNoMatch?.(song, res.results);
      }
    },
  });
}
