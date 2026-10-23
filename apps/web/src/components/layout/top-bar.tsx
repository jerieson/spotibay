import { Library } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { UserAvatar } from '@/components/user-avatar';
import { useSession } from '@/hooks/use-session';

export function TopBar() {
  const session = useSession();

  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
      <div className="flex h-16 items-center gap-3 mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-8">
        <Link to="/" aria-label="Spotibay home">
          <Logo />
        </Link>
        <div className="flex-1" />
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
