import { useState, type ComponentProps } from 'react';
import type { ReactionEmoji as Emoji } from '@spotibay/shared';
import { cn } from '@/lib/utils';

/** Noto animated emoji (Google, CC BY 4.0), shrunk and served from `public/emoji`. */
const files: Record<Emoji, string> = {
  '❤️': 'heart',
  '🔥': 'fire',
  '👏': 'clap',
  '😂': 'joy',
  '😮': 'wow',
  '🎉': 'party',
  '👍': 'thumbs-up',
  '🎶': 'notes',
};

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const emojiSrc = (emoji: Emoji, animated: boolean) =>
  `/emoji/${files[emoji]}${animated && !prefersReducedMotion() ? '' : '-still'}.webp`;

/** A reaction emoji as an image: still by default, animated when `animated` is set. */
export function ReactionEmoji({
  emoji,
  animated = false,
  className,
}: {
  emoji: Emoji;
  animated?: boolean;
  className?: string;
}) {
  return (
    <img
      src={emojiSrc(emoji, animated)}
      alt={emoji}
      draggable={false}
      className={cn('size-6 select-none', className)}
    />
  );
}

/** A round button with a reaction emoji that plays while hovered or focused. */
export function EmojiButton({
  emoji,
  className,
  imageClassName,
  ...props
}: ComponentProps<'button'> & { emoji: Emoji; imageClassName?: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <button
      type="button"
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-full transition-transform hover:scale-125 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-90',
        className,
      )}
      aria-label={`React ${emoji}`}
      onPointerEnter={() => setPlaying(true)}
      onPointerLeave={() => setPlaying(false)}
      onFocus={() => setPlaying(true)}
      onBlur={() => setPlaying(false)}
      {...props}
    >
      <ReactionEmoji emoji={emoji} animated={playing} className={imageClassName} />
    </button>
  );
}
