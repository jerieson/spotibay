import { REACTION_EMOJIS } from '@spotibay/shared';
import { socket } from '@/lib/socket';

export function ReactionBar() {
  return (
    <div
      className="mx-auto grid max-w-md grid-cols-8 justify-items-center gap-1"
      role="group"
      aria-label="Reactions"
    >
      {REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="grid aspect-square w-full max-w-10 place-items-center rounded-full text-lg transition-transform hover:bg-muted active:scale-90 sm:text-xl"
          aria-label={`React ${emoji}`}
          onClick={() => socket.emit('chat:react', { emoji })}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
