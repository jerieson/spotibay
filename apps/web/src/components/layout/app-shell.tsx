import { Outlet } from 'react-router-dom';
import { RecoveryCodeDialog } from '@/components/recovery-code-dialog';
import { PlayerDock } from './player-dock';
import { TopBar } from './top-bar';

export function AppShell() {
  return (
    <div className="min-h-screen">
      <TopBar />
      <main className="mx-auto max-w-5xl px-4 pt-6 pb-32">
        <Outlet />
      </main>
      <PlayerDock />
      <RecoveryCodeDialog />
    </div>
  );
}
