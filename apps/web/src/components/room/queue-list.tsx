import { UserAvatar } from '@/components/user-avatar';
import { formatDuration } from '@/lib/format';
import { useRoomStore } from '@/stores/room';

export function QueueList() {
  const queue = useRoomStore((s) => s.queue);
  if (queue.length === 0) {
    return (
      <p className="rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
        Nothing queued after this track.
      </p>
    );
  }
  return (
    <ol className="divide-y rounded-2xl border bg-card" aria-label="Up next">
      {queue.map((item) => (
        <li key={item.id} className="flex items-center gap-3 p-3" data-testid="queue-item">
          <img
            src={item.track.thumbnailUrl}
            alt=""
            className="size-10 shrink-0 rounded-md object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{item.track.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {item.track.channelTitle} · {formatDuration(item.track.durationSec * 1000)}
            </p>
          </div>
          <UserAvatar
            avatar={item.addedBy.avatar}
            name={`Added by ${item.addedBy.displayName}`}
            className="size-6"
          />
        </li>
      ))}
    </ol>
  );
}
