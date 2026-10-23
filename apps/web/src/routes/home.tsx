import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { roomCodeSchema } from '@spotibay/shared';
import { CreateRoomDialog } from '@/components/room/create-room-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fetchRooms } from '@/lib/api';

export function HomePage() {
  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <section className="relative overflow-hidden rounded-3xl border bg-card p-6 sm:p-10">
        <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-volt/15 blur-3xl" />
        <p className="text-sm font-semibold tracking-widest text-volt-text uppercase">Listen in sync</p>
        <h1 className="mt-2 font-display text-4xl font-extrabold tracking-tight sm:text-5xl">
          One room.
          <br />
          Everyone on the same beat.
        </h1>
        <p className="mt-3 max-w-md text-muted-foreground">
          Spin up a room, share the code, and queue YouTube tracks together.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <CreateRoomDialog />
          <JoinByCode />
        </div>
      </section>
      <PublicRooms />
    </div>
  );
}

function JoinByCode() {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const parsed = roomCodeSchema.safeParse(value);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (parsed.success) void navigate(`/r/${parsed.data}`);
  }

  return (
    <form onSubmit={submit} className="flex gap-2">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Room code"
        aria-label="Room code"
        maxLength={6}
        autoCapitalize="characters"
        autoComplete="off"
        className="h-10 w-36 rounded-full font-mono tracking-widest uppercase"
      />
      <Button
        type="submit"
        variant="secondary"
        size="lg"
        className="rounded-full"
        disabled={!parsed.success}
      >
        Join <ArrowRight />
      </Button>
    </form>
  );
}

function PublicRooms() {
  const rooms = useQuery({ queryKey: ['rooms'], queryFn: fetchRooms, refetchInterval: 10_000 });

  return (
    <section className="space-y-3">
      <h2 className="font-display text-xl font-bold">Public rooms</h2>
      {rooms.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {rooms.isError && <p className="text-sm text-destructive">Couldn&apos;t load rooms.</p>}
      {rooms.isSuccess && rooms.data.length === 0 && (
        <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No public rooms yet. Create the first one!
        </p>
      )}
      {rooms.isSuccess && rooms.data.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rooms.data.map((room) => (
            <li key={room.code}>
              <Link
                to={`/r/${room.code}`}
                className="flex items-center gap-3 rounded-2xl border bg-card p-4 transition-colors hover:border-volt/60"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{room.name}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {room.nowPlaying ? room.nowPlaying.title : 'Nothing playing'}
                  </p>
                </div>
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  <Users className="size-4" /> {room.memberCount}
                </span>
                <span className="font-mono text-sm tracking-widest text-volt-text">{room.code}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
