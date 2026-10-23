import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { importPlaylist } from '@/lib/api';

export function ImportPlaylistDialog() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');

  const run = useMutation({
    mutationFn: () => importPlaylist(url.trim(), name.trim()),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      toast(
        res.skipped > 0
          ? `Imported ${res.added} tracks, skipped ${res.skipped} that can't be played here`
          : `Imported ${res.added} tracks`,
      );
      setOpen(false);
      setUrl('');
      setName('');
      void navigate(`/library/playlists/${res.playlist.id}`);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (url.trim()) run.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <Download /> Import from YouTube
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import a YouTube playlist</DialogTitle>
          <DialogDescription>
            Public and unlisted playlists work. Videos that can&apos;t be embedded are skipped.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/playlist?list=…"
            aria-label="YouTube playlist link"
            maxLength={300}
            inputMode="url"
            autoComplete="off"
            autoFocus
          />
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
            aria-label="Playlist name"
            maxLength={60}
            autoComplete="off"
          />
          {run.isError && (
            <Alert variant="destructive">
              <AlertDescription>{run.error.message}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" className="w-full" disabled={url.trim() === '' || run.isPending}>
            {run.isPending ? 'Importing…' : 'Import'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
