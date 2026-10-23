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
    <div className="min-h-dvh">
      <SiteBanner />
      <TopBar />
      <main className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-8 pt-6 pb-36">
        <Outlet />
      </main>
      <PlayerDock />
      <RecoveryCodeDialog />
      <Toaster />
    </div>
  );
}
