import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Track } from '@spotibay/shared';
import { fetchLikes, setLiked } from '@/lib/api';
import { friendlyError } from '@/lib/errors';

export const likesKey = ['likes'] as const;

/** The signed-in guest's liked songs, plus a toggle that updates the heart right away. */
export function useLikes() {
  const qc = useQueryClient();
  const likes = useQuery({ queryKey: likesKey, queryFn: fetchLikes });

  const toggle = useMutation({
    mutationFn: ({ track, liked }: { track: Track; liked: boolean }) =>
      setLiked(track.videoId, liked),
    onMutate: async ({ track, liked }) => {
      await qc.cancelQueries({ queryKey: likesKey });
      const previous = qc.getQueryData<Track[]>(likesKey);
      qc.setQueryData<Track[]>(likesKey, (old = []) =>
        liked
          ? [track, ...old.filter((t) => t.videoId !== track.videoId)]
          : old.filter((t) => t.videoId !== track.videoId),
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      qc.setQueryData(likesKey, ctx?.previous);
      toast.error(friendlyError(err));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: likesKey }),
  });

  const ids = new Set((likes.data ?? []).map((t) => t.videoId));
  return {
    isLoading: likes.isPending,
    tracks: likes.data ?? [],
    isLiked: (videoId: string) => ids.has(videoId),
    toggle: (track: Track) => toggle.mutate({ track, liked: !ids.has(track.videoId) }),
  };
}
