import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListPlus, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { Track } from '@spotibay/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { addToPlaylist, createPlaylist, fetchPlaylists } from '@/lib/api';
import { friendlyError } from '@/lib/errors';

/** A button that opens a picker to put `track` in one of the user's playlists, or a new one. */
export function AddToPlaylistDialog({ track }: { track: Track }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: fetchPlaylists, enabled: open });

  const add = useMutation({
    mutationFn: async (target: { id: string } | { name: string }) => {
      const id = 'id' in target ? target.id : (await createPlaylist(target.name)).id;
      return addToPlaylist(id, [track.videoId]);
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      void qc.invalidateQueries({ queryKey: ['playlist', res.playlist.id] });
      toast(res.added > 0 ? `Added to ${res.playlist.name}` : `Already in ${res.playlist.name}`);
      setOpen(false);
      setName('');
    },
    onError: (err) => toast.error(friendlyError(err)),
  });

  function create(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) add.mutate({ name: name.trim() });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 shrink-0"
          aria-label={`Add ${track.title} to a playlist`}
        >
          <ListPlus />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to playlist</DialogTitle>
          <DialogDescription className="truncate">{track.title}</DialogDescription>
        </DialogHeader>
        <form onSubmit={create} className="flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New playlist name"
            aria-label="New playlist name"
            maxLength={60}
            autoComplete="off"
          />
          <Button type="submit" variant="secondary" disabled={name.trim() === '' || add.isPending}>
            <Plus /> Create
          </Button>
        </form>
        {playlists.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {playlists.isError && (
          <p role="alert" className="text-sm text-destructive">
            Couldn&apos;t load your playlists.
          </p>
        )}
        {playlists.data && playlists.data.length === 0 && (
          <p className="text-sm text-muted-foreground">You have no playlists yet.</p>
        )}
        {playlists.data && playlists.data.length > 0 && (
          <ul className="max-h-64 divide-y overflow-y-auto rounded-xl border">
            {playlists.data.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm hover:bg-accent disabled:opacity-60"
                  disabled={add.isPending}
                  onClick={() => add.mutate({ id: p.id })}
                >
                  <span className="truncate font-medium">{p.name}</span>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {p.itemCount} tracks
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
