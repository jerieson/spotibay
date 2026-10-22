import { Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { roomCodeSchema } from '@spotibay/shared';
import { CopyButton } from '@/components/copy-button';
import { AddMusicSheet } from '@/components/room/add-music-sheet';
import { PlayerPanel } from '@/components/room/player-panel';
import { QueueList } from '@/components/room/queue-list';
import { MemberList } from '@/components/room/member-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRoomConnection } from '@/hooks/use-room';
import { useSession } from '@/hooks/use-session';
import { useRoomStore } from '@/stores/room';

export function RoomPage() {
  const params = useParams();
  const parsed = roomCodeSchema.safeParse(params.code);
  if (!parsed.success)
    return <Notice title="Room not found" detail="That room code isn't valid." />;
  return <Room key={parsed.data} code={parsed.data} />;
}

function Room({ code }: { code: string }) {
  const session = useSession();
  const { submitPassword } = useRoomConnection(code);
  const { status, error, room, members, you } = useRoomStore();

  if (status === 'closed') return <Notice title="This room has been closed" />;
  if (status === 'failed') {
    return (
      <Notice title="Can't join this room" detail={error?.message ?? 'Something went wrong.'} />
    );
  }
  if (status === 'needs-password') {
    return <PasswordPrompt wrong={error !== null} onSubmit={submitPassword} />;
  }
  if (status !== 'joined' || !room || !you || !session.data) {
    return <p className="text-muted-foreground">Joining room…</p>;
  }

  const inviteLink = `${window.location.origin}/r/${room.code}`;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-3xl font-extrabold tracking-tight">
            {room.name}
            {room.hasPassword && (
              <Lock
                className="ml-2 inline size-5 text-muted-foreground"
                aria-label="Password protected"
              />
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            Code <span className="font-mono tracking-widest text-volt">{room.code}</span> ·{' '}
            {members.length} {members.length === 1 ? 'listener' : 'listeners'}
          </p>
        </div>
        <CopyButton text={inviteLink} label="Copy invite link" />
      </header>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          <PlayerPanel />
          <AddMusicSheet />
        </div>
        <div className="space-y-6">
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">Up next</h2>
            <QueueList />
          </section>
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">In the room</h2>
            <MemberList members={members} selfId={you.userId} viewerRole={you.role} />
          </section>
        </div>
      </div>
    </div>
  );
}

function PasswordPrompt({
  wrong,
  onSubmit,
}: {
  wrong: boolean;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(password);
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-sm space-y-4 rounded-2xl border bg-card p-6">
      <h1 className="flex items-center gap-2 font-display text-xl font-bold">
        <Lock className="size-5" /> This room is private
      </h1>
      <Input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Room password"
        aria-label="Room password"
        autoFocus
        autoComplete="off"
      />
      {wrong && <p className="text-sm text-destructive">That password didn&apos;t work.</p>}
      <Button type="submit" className="w-full" disabled={password === ''}>
        Join room
      </Button>
    </form>
  );
}

function Notice({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="mx-auto max-w-sm space-y-3 rounded-2xl border bg-card p-6 text-center">
      <h1 className="font-display text-xl font-bold">{title}</h1>
      {detail && <p className="text-sm text-muted-foreground">{detail}</p>}
      <Button asChild variant="secondary">
        <Link to="/">Back home</Link>
      </Button>
    </div>
  );
}
