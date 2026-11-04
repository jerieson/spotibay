import { SmilePlus } from 'lucide-react';
import { QUICK_REACTION_COUNT, REACTION_EMOJIS, type ReactionEmoji } from '@spotibay/shared';
import { EmojiButton } from '@/components/reaction-emoji';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { socket } from '@/lib/socket';

const react = (emoji: ReactionEmoji) => socket.emit('chat:react', { emoji });
const quick = REACTION_EMOJIS.slice(0, QUICK_REACTION_COUNT);

/**
 * Floating reactions over the video, between the volume and resync controls. The first few sit
 * inline where there's room; one button opens them all (on phones it's the only one, so the
 * volume slider keeps its width).
 */
export function ReactionBar() {
  return (
    <div className="flex shrink-0 items-center justify-center sm:min-w-0 sm:flex-1">
      <div className="hidden items-center sm:flex" role="group" aria-label="Reactions">
        {quick.map((emoji) => (
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
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full sm:size-8"
            aria-label="More reactions"
            title="More reactions"
          >
            <SmilePlus />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="center"
          collisionPadding={16}
          className="grid w-auto grid-cols-6 gap-1 rounded-2xl p-2 sm:grid-cols-8"
          role="group"
          aria-label="All reactions"
        >
          {REACTION_EMOJIS.map((emoji) => (
            // Stays open so people can fire off several in a row.
            <EmojiButton
              key={emoji}
              emoji={emoji}
              className="size-11 sm:size-10"
              imageClassName="size-8"
              onClick={() => react(emoji)}
            />
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
