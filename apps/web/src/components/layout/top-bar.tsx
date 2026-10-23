import { Library, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { UserAvatar } from '@/components/user-avatar';
import { useSession } from '@/hooks/use-session';

export function TopBar() {
  const session = useSession();

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
        <Link
          to="/library"
          aria-label="Library"
          className="flex shrink-0 items-center gap-1.5 rounded-full px-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <Library className="size-5" />
          <span className="hidden sm:inline">Library</span>
        </Link>
        <ThemeToggle />
        <Link
          to="/profile"
          aria-label="Profile"
          className="shrink-0 rounded-full ring-2 ring-volt/60"
        >
          {session.data ? (
            <UserAvatar avatar={session.data.avatar} name={session.data.displayName} />
          ) : (
            <div className="size-9 rounded-full bg-volt/20" />
          )}
        </Link>
      </div>
    </header>
  );
}
