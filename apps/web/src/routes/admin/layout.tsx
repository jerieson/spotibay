import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  DoorOpen,
  Gauge,
  LogOut,
  MessageSquareWarning,
  ScrollText,
  Settings,
  ShieldBan,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { io } from 'socket.io-client';
import type { AdminStats } from '@spotibay/shared';
import { Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { adminApi } from './admin-api';
import { Card } from './ui';

export const adminStatsKey = ['admin', 'stats'] as const;

const nav: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: '/admin', label: 'Dashboard', icon: Gauge, end: true },
  { to: '/admin/settings', label: 'Settings', icon: Settings },
  { to: '/admin/rooms', label: 'Rooms', icon: DoorOpen },
  { to: '/admin/users', label: 'Users & Bans', icon: ShieldBan },
  { to: '/admin/chat', label: 'Chat', icon: MessageSquareWarning },
  { to: '/admin/quota', label: 'Quota', icon: Activity },
  { to: '/admin/audit', label: 'Audit Log', icon: ScrollText },
];

export function AdminLayout() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me, retry: false });

  if (me.isPending) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Login onDone={() => void qc.invalidateQueries({ queryKey: ['admin', 'me'] })} />;
  }
  if (me.isError) return <p className="p-6 text-destructive">{me.error.message}</p>;

  return <Panel username={me.data.username} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => adminApi.login(username, password),
    onSuccess: onDone,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm space-y-4 p-6">
        <Logo />
        <h1 className="font-display text-xl font-extrabold">Admin sign in</h1>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="admin-user">Username</Label>
            <Input
              id="admin-user"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-pass">Password</Label>
            <Input
              id="admin-pass"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {login.error && (
            <p role="alert" className="text-sm text-destructive">
              {login.error.message}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={login.isPending || !username || !password}
          >
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}

/** Live counts from the `/admin` namespace, written into the query cache. */
function useLiveStats() {
  const qc = useQueryClient();
  useEffect(() => {
    const socket = io('/admin');
    socket.on('admin:stats', (stats: AdminStats) => qc.setQueryData(adminStatsKey, stats));
    return () => {
      socket.disconnect();
    };
  }, [qc]);
}

function Panel({ username }: { username: string }) {
  const qc = useQueryClient();
  useLiveStats();
  const logout = useMutation({
    mutationFn: adminApi.logout,
    onSuccess: () => qc.resetQueries({ queryKey: ['admin'] }),
  });

  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-4 py-3 md:block md:space-y-1">
          <Logo />
          <p className="hidden text-xs text-muted-foreground md:block">Admin · {username}</p>
          <div className="flex items-center gap-1 md:hidden">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              onClick={() => logout.mutate()}
            >
              <LogOut />
            </Button>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:px-3">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-4 hidden items-center gap-1 px-3 md:flex">
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={() => logout.mutate()}>
            <LogOut /> Sign out
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-6">
        <Outlet />
      </main>
      <Toaster />
    </div>
  );
}
