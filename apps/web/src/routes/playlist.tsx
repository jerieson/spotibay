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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Globe, GripVertical, Lock, Trash2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { moveItem, type PlaylistDetail, type PlaylistItem } from '@spotibay/shared';
import { CopyButton } from '@/components/copy-button';
import { LikeButton } from '@/components/library/like-button';
import { TrackRow } from '@/components/library/track-row';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ApiError,
  deletePlaylist,
  fetchPlaylist,
  removePlaylistItem,
  reorderPlaylistItem,
  updatePlaylist,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { friendlyError } from '@/lib/errors';

export function PlaylistPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const key = ['playlist', id] as const;
  const playlist = useQuery({ queryKey: key, queryFn: () => fetchPlaylist(id) });
  const [editing, setEditing] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const refresh = () => void qc.invalidateQueries({ queryKey: ['playlists'] });
  const onSaved = (p: PlaylistDetail) => {
    qc.setQueryData(key, p);
    refresh();
  };
  const update = useMutation({
    mutationFn: (body: { name?: string; isPublic?: boolean }) => updatePlaylist(id, body),
    onSuccess: (p) => {
      onSaved(p);
      setEditing(null);
    },
    onError: (err) => toast.error(friendlyError(err)),
  });
  const remove = useMutation({
    mutationFn: () => deletePlaylist(id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: key });
      refresh();
      void navigate('/library');
    },
    onError: (err) => toast.error(friendlyError(err)),
  });
  const removeItem = useMutation({
    mutationFn: (itemId: string) => removePlaylistItem(id, itemId),
    onSuccess: onSaved,
    onError: (err) => toast.error(friendlyError(err)),
  });
  const reorder = useMutation({
    mutationFn: ({ itemId, toIndex }: { itemId: string; toIndex: number }) =>
      reorderPlaylistItem(id, itemId, toIndex),
    onMutate: ({ itemId, toIndex }) => {
      const previous = qc.getQueryData<PlaylistDetail>(key);
      // Show the move at once; the server's answer replaces it.
      if (previous)
        qc.setQueryData(key, { ...previous, items: moveItem(previous.items, itemId, toIndex) });
      return { previous };
    },
    onSuccess: onSaved,
    onError: (err, _vars, ctx) => {
      qc.setQueryData(key, ctx?.previous);
      toast.error(friendlyError(err));
    },
  });

  if (playlist.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (playlist.isError) {
    const missing =
      playlist.error instanceof ApiError &&
      playlist.error.status >= 400 &&
      playlist.error.status < 500;
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-muted-foreground">
          {missing
            ? 'This playlist does not exist or is not yours.'
            : 'Couldn’t load the playlist.'}
        </p>
        <Button asChild variant="secondary">
          <Link to="/library">Back to library</Link>
        </Button>
      </div>
    );
  }

  const p = playlist.data;
  const shareUrl = `${window.location.origin}/p/${p.shareSlug}`;

  function rename(e: FormEvent) {
    e.preventDefault();
    if (editing?.trim()) update.mutate({ name: editing.trim() });
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const toIndex = p.items.findIndex((i) => i.id === over.id);
    if (toIndex !== -1) reorder.mutate({ itemId: String(active.id), toIndex });
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/library">
          <ArrowLeft /> Library
        </Link>
      </Button>

      <header className="space-y-3">
        {editing === null ? (
          <h1
            className="cursor-text font-display text-3xl font-extrabold tracking-tight"
            title="Click to rename"
            onClick={() => setEditing(p.name)}
          >
            {p.name}
          </h1>
        ) : (
          <form onSubmit={rename} className="flex gap-2">
            <Input
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              maxLength={60}
              aria-label="Playlist name"
              autoFocus
            />
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </form>
        )}
        <p className="text-sm text-muted-foreground">
          {p.itemCount} {p.itemCount === 1 ? 'track' : 'tracks'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={p.isPublic ? 'default' : 'secondary'}
            size="sm"
            aria-pressed={p.isPublic}
            disabled={update.isPending}
            onClick={() => update.mutate({ isPublic: !p.isPublic })}
          >
            {p.isPublic ? <Globe /> : <Lock />}
            {p.isPublic ? 'Shared: anyone with the link' : 'Private'}
          </Button>
          {p.isPublic && (
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={shareUrl}
                aria-label="Share link"
                className="h-8 w-56 text-sm"
              />
              <CopyButton text={shareUrl} label="Copy share link" />
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`Delete “${p.name}”?`)) remove.mutate();
            }}
          >
            <Trash2 /> Delete
          </Button>
        </div>
      </header>

      {p.items.length === 0 ? (
        <p className="rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
          Empty. Search for songs in a room and use the playlist button to add them here.
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={p.items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <ol className="divide-y rounded-2xl border bg-card" aria-label="Tracks">
              {p.items.map((item) => (
                <SortableRow
                  key={item.id}
                  item={item}
                  onRemove={() => removeItem.mutate(item.id)}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

function SortableRow({ item, onRemove }: { item: PlaylistItem; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex items-center bg-card pl-2 first:rounded-t-2xl last:rounded-b-2xl',
        isDragging && 'z-10 shadow-lg',
      )}
      data-testid="playlist-item"
    >
      <button
        type="button"
        className="shrink-0 cursor-grab touch-none rounded p-1 text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing"
        aria-label={`Reorder ${item.track.title}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <div className="min-w-0 flex-1">
        <TrackRow track={item.track}>
          <LikeButton track={item.track} />
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={`Remove ${item.track.title}`}
            onClick={onRemove}
          >
            <X />
          </Button>
        </TrackRow>
      </div>
    </li>
  );
}
