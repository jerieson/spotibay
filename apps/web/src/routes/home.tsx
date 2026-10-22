import { useQuery } from '@tanstack/react-query';
import { ThemeToggle } from '@/components/theme-toggle';
import { fetchHealth } from '@/lib/api';

export function HomePage() {
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth });

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          Spoti<span className="text-volt">bay</span>
        </h1>
        <ThemeToggle />
      </header>
      <section className="rounded-lg border bg-card p-4 text-card-foreground">
        <h2 className="mb-1 text-sm text-muted-foreground">API health</h2>
        <p data-testid="health" className="font-mono">
          {health.isPending && 'checking…'}
          {health.isError && 'unreachable'}
          {health.isSuccess && `status: ${health.data.status}`}
        </p>
      </section>
    </main>
  );
}
