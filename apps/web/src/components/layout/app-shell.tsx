import { Outlet, useSearchParams } from 'react-router-dom';
import { RecoveryCodeDialog } from '@/components/recovery-code-dialog';
import { Toaster } from '@/components/ui/sonner';
import { useSite } from '@/hooks/use-site';
import { MaintenancePage } from './maintenance';
import { PlayerDock } from './player-dock';
import { SiteBanner } from './site-banner';
import { TopBar } from './top-bar';

export function AppShell() {
  const site = useSite();
  // The admin "join as host" link works during maintenance; the server still checks the admin cookie.
  const adminJoin = useSearchParams()[0].get('admin') === '1';
  if (site.data?.maintenance && !adminJoin) return <MaintenancePage />;

  return (
    <div className="min-h-screen">
      <SiteBanner />
      <TopBar />
      <main className="mx-auto max-w-5xl px-4 pt-6 pb-32">
        <Outlet />
      </main>
      <PlayerDock />
      <RecoveryCodeDialog />
      <Toaster />
    </div>
  );
}
