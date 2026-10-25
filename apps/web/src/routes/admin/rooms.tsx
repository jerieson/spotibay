import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { UserAvatar } from '@/components/user-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { adminApi } from './admin-api';
import { Card, Empty, formatTime, PageHeader, QueryState } from './ui';

export function RoomsPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const rooms = useQuery({
    queryKey: ['admin', 'rooms'],
    queryFn: adminApi.rooms,
    refetchInterval: 5000,
  });

  return (
    <>
      <PageHeader title="Rooms" />
      <QueryState isPending={rooms.isPending} error={rooms.error} />
      {rooms.data?.length === 0 && <Empty>No open rooms.</Empty>}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="space-y-2">
          {rooms.data?.map((r) => (
            <button
              key={r.code}
              type="button"
              onClick={() => setSelected(r.code)}
              className="block w-full rounded-2xl border bg-card p-4 text-left transition-colors hover:border-ring/60 aria-pressed:border-ring"
              aria-pressed={selected === r.code}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{r.name}</span>
                <Badge className="font-mono">{r.code}</Badge>
                {r.visibility === 'private' && <Badge variant="outline">private</Badge>}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {r.memberCount} listening · {r.queueLength} queued · host {r.hostName ?? 'unknown'}
              </p>
              <p className="truncate text-sm">
                {r.nowPlaying ? r.nowPlaying.title : 'Nothing playing'}
              </p>
            </button>
          ))}
        </div>
        {selected && <RoomDetail key={selected} code={selected} onGone={() => setSelected(null)} />}
      </div>
    </>
  );
}

function RoomDetail({ code, onGone }: { code: string; onGone: () => void }) {
  const qc = useQueryClient();
  const room = useQuery({
    queryKey: ['admin', 'room', code],
    queryFn: () => adminApi.room(code),
    refetchInterval: 5000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const close = useMutation({
    mutationFn: () => adminApi.closeRoom(code),
    onSuccess: async () => {
      toast.success(`Closed ${code}`);
      await refresh();
      onGone();
    },
    onError: (e) => toast.error(e.message),
  });
  const kick = useMutation({
    mutationFn: (userId: string) => adminApi.kick(code, userId),
    onSuccess: async () => {
      toast.success('Removed from the room');
      await refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  if (room.isError)
    return <Card className="text-sm text-muted-foreground">This room is gone.</Card>;
  if (!room.data) return <QueryState isPending error={null} />;
  const r = room.data;

  return (
    <Card className="space-y-4 self-start">
      <div>
        <h2 className="font-semibold">{r.name}</h2>
        <p className="text-sm text-muted-foreground">
          Created {formatTime(r.createdAt)} · {r.queueMode} queue
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <a href={`/r/${code}?admin=1`} target="_blank" rel="noreferrer">
            Join as host
          </a>
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={close.isPending}
          onClick={() => {
            if (window.confirm(`Close room ${r.name}? Everyone in it is removed.`)) close.mutate();
          }}
        >
          Close room
        </Button>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-semibold">Members ({r.members.length})</h3>
        <ul className="space-y-1.5">
          {r.members.map((m) => (
            <li key={m.userId} className="flex items-center gap-2 text-sm">
              <UserAvatar avatar={m.avatar} name={m.displayName} className="size-7" />
              <span className="min-w-0 flex-1 truncate">{m.displayName}</span>
              <Badge variant="outline">{m.role}</Badge>
              <Button
                size="sm"
                variant="ghost"
                disabled={kick.isPending}
                onClick={() => kick.mutate(m.userId)}
              >
                Kick
              </Button>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-semibold">Queue ({r.queue.length})</h3>
        {r.playback.item && (
          <p className="text-sm">
            <span className="text-muted-foreground">{r.playback.status}: </span>
            {r.playback.item.track.title}
          </p>
        )}
        <ol className="list-decimal space-y-0.5 pl-5 text-sm text-muted-foreground">
          {r.queue.slice(0, 10).map((q) => (
            <li key={q.id} className="truncate">
              {q.track.title}
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}
