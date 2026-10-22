import { Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';

export function TopBar() {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
        <Link to="/" aria-label="Spotibay home">
          <Logo />
        </Link>
        <button
          type="button"
          className="mx-auto flex h-9 w-full max-w-md items-center gap-2 rounded-full border bg-card px-4 text-sm text-muted-foreground transition-colors hover:border-ring/60"
        >
          <Search className="size-4" />
          Search or paste a YouTube link
        </button>
        <ThemeToggle />
        <div
          className="size-9 shrink-0 rounded-full bg-volt/20 ring-2 ring-volt/60"
          aria-label="Profile"
        />
      </div>
    </header>
  );
}
