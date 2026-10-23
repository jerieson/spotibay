import { Wrench } from 'lucide-react';
import { Logo } from '@/components/logo';

export function MaintenancePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <Logo />
      <Wrench className="size-10 text-muted-foreground" aria-hidden />
      <h1 className="font-display text-3xl font-extrabold tracking-tight">
        Back in a little while
      </h1>
      <p className="max-w-sm text-muted-foreground">
        Spotibay is down for maintenance. Your rooms and playlists are safe; try again in a few
        minutes.
      </p>
    </div>
  );
}
