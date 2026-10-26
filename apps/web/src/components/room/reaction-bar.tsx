import { SmilePlus } from 'lucide-react';
import { REACTION_EMOJIS, type ReactionEmoji } from '@spotibay/shared';
import { EmojiButton } from '@/components/reaction-emoji';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { socket } from '@/lib/socket';

const react = (emoji: ReactionEmoji) => socket.emit('chat:react', { emoji });

/**
 * Floating reactions over the video, between the volume and resync controls. Inline where there's
 * room; on phones one button opens them, so the volume slider keeps its width.
 */
export function ReactionBar() {
  return (
    <div className="flex shrink-0 justify-center sm:min-w-0 sm:flex-1">
      <div className="hidden items-center sm:flex" role="group" aria-label="Reactions">
        {REACTION_EMOJIS.map((emoji) => (
          <EmojiButton
            key={emoji}
            emoji={emoji}
            className="size-8"
            imageClassName="size-7"
            onClick={() => react(emoji)}
          />
        ))}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="rounded-full sm:hidden" aria-label="React">
            <SmilePlus />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="center"
          collisionPadding={16}
          className="grid w-auto grid-cols-4 gap-1 rounded-2xl p-2"
          role="group"
          aria-label="Reactions"
        >
          {REACTION_EMOJIS.map((emoji) => (
            // Stays open so people can fire off several in a row.
            <EmojiButton
              key={emoji}
              emoji={emoji}
              className="size-12"
              imageClassName="size-8"
              onClick={() => react(emoji)}
            />
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
