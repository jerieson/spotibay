import { REACTION_EMOJIS } from '@spotibay/shared';
import { socket } from '@/lib/socket';

export function ReactionBar() {
  return (
    <div className="flex flex-wrap justify-center gap-1" role="group" aria-label="Reactions">
      {REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="grid size-10 place-items-center rounded-full text-xl transition-transform hover:bg-muted active:scale-90"
          aria-label={`React ${emoji}`}
          onClick={() => socket.emit('chat:react', { emoji })}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
