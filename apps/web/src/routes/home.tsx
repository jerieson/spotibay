import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from '@/lib/api';

export function HomePage() {
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth });

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-3xl border bg-card p-6 sm:p-10">
        <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-volt/15 blur-3xl" />
        <p className="text-xs font-semibold tracking-widest text-volt uppercase">Listen in sync</p>
        <h1 className="mt-2 font-display text-4xl font-extrabold tracking-tight sm:text-5xl">
          One room.
          <br />
          Everyone on the same beat.
        </h1>
        <p className="mt-3 max-w-md text-muted-foreground">
          Spin up a room, share the code, and queue YouTube tracks together.
        </p>
      </section>
      <section className="rounded-2xl border bg-card p-4 text-card-foreground">
        <h2 className="mb-1 text-sm text-muted-foreground">API health</h2>
        <p data-testid="health" className="font-mono">
          {health.isPending && 'checking…'}
          {health.isError && 'unreachable'}
          {health.isSuccess && `status: ${health.data.status}`}
        </p>
      </section>
    </div>
  );
}
