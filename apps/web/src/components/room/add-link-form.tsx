import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { socket } from '@/lib/socket';

export function AddLinkForm() {
  const [url, setUrl] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    socket.emit('queue:add', { url: trimmed });
    setUrl('');
  }

  return (
    <form onSubmit={submit} className="flex gap-2">
      <Input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Paste a YouTube link"
        aria-label="YouTube link"
        maxLength={300}
        inputMode="url"
        autoComplete="off"
      />
      <Button type="submit" disabled={url.trim() === ''}>
        <Plus /> Add
      </Button>
    </form>
  );
}
