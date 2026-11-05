import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CloudRain,
  Coffee,
  Disc3,
  Flame,
  Headphones,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  roomCodeSchema,
  VIBES,
  vibeIdSchema,
  type CatalogTrack,
  type VibeId,
} from '@spotibay/shared';
import { CreateRoomDialog } from '@/components/room/create-room-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { useSession } from '@/hooks/use-session';
import { fetchRecommendations, fetchRooms, fetchVibe, RECOMMENDATIONS_STALE_MS } from '@/lib/api';
import { cn } from '@/lib/utils';

export function HomePage() {
  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <section className="relative overflow-hidden rounded-3xl border bg-card p-6 sm:p-10">
        <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-volt/15 blur-3xl" />
        <p className="text-sm font-semibold tracking-widest text-volt-text uppercase">
          Listen in sync
        </p>
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
      <Vibes />
      <ForYou />
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
    <form onSubmit={submit} className="flex w-full gap-2 sm:w-auto">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Room code"
        aria-label="Room code"
        maxLength={6}
        autoCapitalize="characters"
        autoComplete="off"
        className="h-10 min-w-0 flex-1 rounded-full font-mono tracking-widest uppercase sm:w-36 sm:flex-none"
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

const VIBE_KEY = 'home:vibe';
/** Cached on the server for the day, so a short stale time only saves a refetch. */
const VIBE_STALE_MS = 10 * 60 * 1000;

/** How each vibe looks: an icon and a soft colour wash behind it. */
const vibeLooks: Record<VibeId, { icon: LucideIcon; wash: string; iconColor: string }> = {
  'work-mode': { icon: Zap, wash: 'bg-amber-400/25', iconColor: 'text-amber-500' },
  chillero: { icon: Coffee, wash: 'bg-teal-400/25', iconColor: 'text-teal-500' },
  'ultimate-relapse': { icon: CloudRain, wash: 'bg-sky-400/25', iconColor: 'text-sky-500' },
  trending: { icon: Flame, wash: 'bg-volt/25', iconColor: 'text-volt-text' },
  throwback: { icon: Disc3, wash: 'bg-fuchsia-400/25', iconColor: 'text-fuchsia-500' },
  focus: { icon: Headphones, wash: 'bg-violet-400/25', iconColor: 'text-violet-500' },
};

function storedVibe(): VibeId {
  try {
    const parsed = vibeIdSchema.safeParse(localStorage.getItem(VIBE_KEY));
    if (parsed.success) return parsed.data;
  } catch {
    // Storage blocked: start from the first vibe.
  }
  return VIBES[0]!.id;
}

/** Moods and genres to start from; the picked one's songs show below, and tapping one starts a room. */
function Vibes() {
  const session = useSession();
  const [vibeId, setVibeId] = useState<VibeId>(storedVibe);
  const songs = useQuery({
    queryKey: ['vibe', vibeId],
    queryFn: () => fetchVibe(vibeId),
    enabled: session.isSuccess,
    staleTime: VIBE_STALE_MS,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const vibe = VIBES.find((v) => v.id === vibeId)!;

  function pick(id: VibeId) {
    setVibeId(id);
    try {
      localStorage.setItem(VIBE_KEY, id);
    } catch {
      // Not remembered; it still works for this visit.
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="vibes-title">
      <div>
        <h2 id="vibes-title" className="font-display text-xl font-bold">
          What&apos;s the vibe?
        </h2>
        <p className="text-sm text-muted-foreground">
          Pick a mood, then tap a song to start a room with it.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {VIBES.map((v) => {
          const look = vibeLooks[v.id];
          const Icon = look.icon;
          const selected = v.id === vibeId;
          return (
            <button
              key={v.id}
              type="button"
              aria-pressed={selected}
              onClick={() => pick(v.id)}
              className={cn(
                'relative overflow-hidden rounded-2xl border bg-card p-4 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                selected ? 'border-volt ring-1 ring-volt' : 'hover:border-volt/60',
              )}
            >
              <span
                className={cn(
                  'pointer-events-none absolute -top-8 -right-8 size-24 rounded-full blur-2xl',
                  look.wash,
                )}
              />
              <Icon className={cn('relative size-6', look.iconColor)} aria-hidden />
              <span className="relative mt-3 block font-display font-bold leading-tight">
                {v.name}
              </span>
              <span className="relative mt-0.5 block text-xs text-muted-foreground">
                {v.tagline}
              </span>
            </button>
          );
        })}
      </div>
      {songs.isPending && session.isSuccess && (
        <p className="text-sm text-muted-foreground">Loading songs…</p>
      )}
      {songs.isError && (
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t load songs for {vibe.name} right now. Try again in a moment.
        </p>
      )}
      {songs.data && songs.data.suggestions.length > 0 && (
        <SongRow
          songs={songs.data.suggestions}
          label={vibe.name}
          dimmed={songs.isPlaceholderData}
        />
      )}
    </section>
  );
}

/** Songs that go with the last one you played; hidden until you've played something. */
function ForYou() {
  const session = useSession();
  const recs = useQuery({
    queryKey: ['recommendations'],
    queryFn: fetchRecommendations,
    enabled: session.isSuccess,
    staleTime: RECOMMENDATIONS_STALE_MS,
    retry: false,
  });

  // Before there's any history the list is just the chart, which the Trending vibe already shows.
  if (recs.data?.basedOn !== 'history' || recs.data.suggestions.length === 0) return null;
  const { seed } = recs.data;

  return (
    <section className="space-y-3" aria-labelledby="for-you-title">
      <div>
        <h2 id="for-you-title" className="font-display text-xl font-bold">
          For you
        </h2>
        <p className="text-sm text-muted-foreground">
          {seed
            ? `Because you played ${seed.title} by ${seed.artist}. Tap one to start a room with it.`
            : "Picked from what you've played. Tap one to start a room with it."}
        </p>
      </div>
      <SongRow songs={recs.data.suggestions} label="For you" />
    </section>
  );
}

/** A row of songs to scroll through; tapping one opens room creation with it. */
function SongRow({
  songs,
  label,
  dimmed = false,
}: {
  songs: CatalogTrack[];
  label: string;
  dimmed?: boolean;
}) {
  const [song, setSong] = useState<CatalogTrack | null>(null);
  return (
    <>
      <ScrollArea
        type="auto"
        className={cn(
          '-mx-1 transition-opacity [&>[data-slot=scroll-area-viewport]]:snap-x',
          dimmed && 'opacity-60',
        )}
      >
        <ul className="flex w-max gap-3 px-1 pb-3" aria-label={label}>
          {songs.map((s) => (
            <li key={s.id} className="w-32 shrink-0 snap-start sm:w-36">
              <button
                type="button"
                onClick={() => setSong(s)}
                className="group w-full rounded-2xl p-1 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label={`Start a room with ${s.title} by ${s.artist}`}
              >
                {s.artworkUrl ? (
                  <img
                    src={s.artworkUrl}
                    alt=""
                    loading="lazy"
                    className="aspect-square w-full rounded-xl bg-muted object-cover"
                  />
                ) : (
                  <div className="aspect-square w-full rounded-xl bg-muted" />
                )}
                <span className="mt-2 block truncate text-sm font-medium">{s.title}</span>
                <span className="block truncate text-sm text-muted-foreground">{s.artist}</span>
              </button>
            </li>
          ))}
        </ul>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
      <CreateRoomDialog
        song={song}
        open={song !== null}
        onOpenChange={(open) => {
          if (!open) setSong(null);
        }}
      />
    </>
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
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                <span className="font-mono text-sm tracking-widest text-volt-text">
                  {room.code}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
