import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp, GripVertical, X } from 'lucide-react';
import { moveItem, queueScore, type QueueItem } from '@spotibay/shared';
import { UserAvatar } from '@/components/user-avatar';
import { Button } from '@/components/ui/button';
import { formatDuration } from '@/lib/format';
import { socket } from '@/lib/socket';
import { cn } from '@/lib/utils';
import { useRoomStore } from '@/stores/room';

export function QueueList() {
  const queue = useRoomStore((s) => s.queue);
  const you = useRoomStore((s) => s.you);
  const canControl = you?.role === 'host' || you?.role === 'dj';
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (queue.length === 0) {
    return (
      <p className="rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
        Nothing queued after this track.
      </p>
    );
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const toIndex = queue.findIndex((i) => i.id === over.id);
    if (toIndex === -1) return;
    const id = String(active.id);
    // Show the move at once; the server's `queue:updated` is the final word.
    useRoomStore.getState().setQueue(moveItem(queue, id, toIndex));
    socket.emit('queue:reorder', { queueItemId: id, toIndex });
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={queue.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        <ol className="divide-y rounded-2xl border bg-card" aria-label="Up next">
          {queue.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              selfId={you?.userId ?? ''}
              canControl={canControl}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function QueueRow({
  item,
  selfId,
  canControl,
}: {
  item: QueueItem;
  selfId: string;
  canControl: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !canControl,
  });
  const score = queueScore(item);
  const myVote = item.votes[selfId] ?? 0;
  const canRemove = canControl || item.addedBy.userId === selfId;
  const vote = (value: 1 | -1) =>
    socket.emit('queue:vote', { queueItemId: item.id, value: myVote === value ? 0 : value });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'relative flex items-center gap-2 bg-card p-2.5 sm:p-3 first:rounded-t-2xl last:rounded-b-2xl',
        isDragging && 'z-10 shadow-lg',
      )}
      data-testid="queue-item"
    >
      {canControl && (
        <button
          type="button"
          className="-ml-1 shrink-0 cursor-grab touch-none rounded p-1 text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing"
          aria-label={`Reorder ${item.track.title}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
      )}
      <img
        src={item.track.thumbnailUrl}
        alt=""
        className="size-10 shrink-0 rounded-md object-cover sm:size-12"
      />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm leading-snug font-medium break-words sm:line-clamp-1 sm:text-base">
          {item.track.title}
        </p>
        <p className="truncate text-sm text-muted-foreground">
          {item.track.channelTitle} · {formatDuration(item.track.durationSec * 1000)}
        </p>
      </div>
      <UserAvatar
        avatar={item.addedBy.avatar}
        name={`Added by ${item.addedBy.displayName}`}
        className="hidden size-6 sm:block"
      />
      <div className="flex shrink-0 items-center" role="group" aria-label="Votes">
        <Button
          size="icon"
          variant="ghost"
          className={cn('size-8 sm:size-9', myVote === 1 && 'text-volt-text')}
          aria-label="Vote up"
          aria-pressed={myVote === 1}
          onClick={() => vote(1)}
        >
          <ChevronUp />
        </Button>
        <span
          className="w-5 text-center text-sm font-semibold tabular-nums sm:w-6"
          aria-label={`Score ${score}`}
          data-testid="queue-score"
        >
          {score}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className={cn('size-8 sm:size-9', myVote === -1 && 'text-destructive')}
          aria-label="Vote down"
          aria-pressed={myVote === -1}
          onClick={() => vote(-1)}
        >
          <ChevronDown />
        </Button>
      </div>
      {canRemove && (
        <Button
          size="icon"
          variant="ghost"
          className="size-8 sm:size-9"
          aria-label={`Remove ${item.track.title}`}
          onClick={() => socket.emit('queue:remove', { queueItemId: item.id })}
        >
          <X />
        </Button>
      )}
    </li>
  );
}
