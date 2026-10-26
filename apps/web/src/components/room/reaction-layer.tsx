import { useEffect, useState } from 'react';
import type { ChatReaction } from '@spotibay/shared';
import { ReactionEmoji } from '@/components/reaction-emoji';
import { socket } from '@/lib/socket';

/** Horizontal spot (percent) derived from the reaction id, so every client shows it in the same place. */
function lane(id: string): number {
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return 8 + (hash % 84);
}

/** Emoji that float up over the player when anyone in the room reacts. */
export function ReactionLayer() {
  const [reactions, setReactions] = useState<ChatReaction[]>([]);

  useEffect(() => {
    const onReaction = (reaction: ChatReaction) =>
      setReactions((prev) => [...prev.slice(-30), reaction]);
    socket.on('chat:reaction', onReaction);
    return () => {
      socket.off('chat:reaction', onReaction);
    };
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden>
      {reactions.map((r) => (
        <span
          key={r.id}
          className="reaction-float absolute bottom-2"
          style={{ left: `${lane(r.id)}%` }}
          onAnimationEnd={() => setReactions((prev) => prev.filter((x) => x.id !== r.id))}
        >
          <ReactionEmoji emoji={r.emoji} animated className="size-10 drop-shadow-lg" />
        </span>
      ))}
    </div>
  );
}
