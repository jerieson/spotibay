import { Heart } from 'lucide-react';
import type { Track } from '@spotibay/shared';
import { Button } from '@/components/ui/button';
import { useLikes } from '@/hooks/use-likes';
import { cn } from '@/lib/utils';

export function LikeButton({ track, className }: { track: Track; className?: string }) {
  const { isLiked, toggle } = useLikes();
  const liked = isLiked(track.videoId);
  return (
    <Button
      size="icon"
      variant="ghost"
      className={cn('size-8 shrink-0', liked && 'text-destructive', className)}
      aria-label={liked ? `Unlike ${track.title}` : `Like ${track.title}`}
      aria-pressed={liked}
      onClick={() => toggle(track)}
    >
      <Heart className={cn(liked && 'fill-current')} />
    </Button>
  );
}
