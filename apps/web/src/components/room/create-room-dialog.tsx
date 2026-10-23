import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ROOM_NAME_MAX,
  ROOM_PASSWORD_MAX,
  ROOM_PASSWORD_MIN,
  type RoomVisibility,
} from '@spotibay/shared';
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
import { Label } from '@/components/ui/label';
import { createRoom } from '@/lib/api';
import { cn } from '@/lib/utils';

export function CreateRoomDialog() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<RoomVisibility>('public');
  const [password, setPassword] = useState('');

  const create = useMutation({
    mutationFn: createRoom,
    onSuccess: (room) => {
      void qc.invalidateQueries({ queryKey: ['rooms'] });
      setOpen(false);
      void navigate(`/r/${room.code}`);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate({
      name,
      visibility,
      password: visibility === 'private' && password ? password : undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="lg" className="rounded-full">
          <Plus /> Create a room
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a room</DialogTitle>
          <DialogDescription>
            You&apos;ll be the host. Share the code to invite people.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="room-name">Room name</Label>
            <Input
              id="room-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={ROOM_NAME_MAX}
              placeholder="Friday night mix"
              required
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label>Visibility</Label>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Visibility">
              {(['public', 'private'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={visibility === v}
                  onClick={() => setVisibility(v)}
                  className={cn(
                    'rounded-xl border p-3 text-left text-sm transition-colors',
                    visibility === v ? 'border-volt bg-volt/10' : 'hover:border-ring/60',
                  )}
                >
                  <span className="block font-medium capitalize">{v}</span>
                  <span className="text-sm text-muted-foreground">
                    {v === 'public' ? 'Listed on the home page' : 'Only people with the code'}
                  </span>
                </button>
              ))}
            </div>
          </div>
          {visibility === 'private' && (
            <div className="space-y-2">
              <Label htmlFor="room-password">Password (optional)</Label>
              <Input
                id="room-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={ROOM_PASSWORD_MIN}
                maxLength={ROOM_PASSWORD_MAX}
                autoComplete="off"
              />
            </div>
          )}
          {create.isError && (
            <Alert variant="destructive">
              <AlertDescription>{create.error.message}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" className="w-full" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create room'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
