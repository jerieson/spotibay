import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppShell } from '@/components/layout/app-shell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { HomePage } from '@/routes/home';
import { LibraryPage } from '@/routes/library';
import { PlaylistPage } from '@/routes/playlist';
import { ProfilePage } from '@/routes/profile';
import { RoomPage } from '@/routes/room';
import { SharedPlaylistPage } from '@/routes/shared-playlist';
import './index.css';

const queryClient = new QueryClient();
const adminPage = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => ({
  lazy: async () => ({ Component: (await load())[name] }),
});

const router = createBrowserRouter([
  {
    path: '/admin',
    lazy: async () => ({ Component: (await import('@/routes/admin/layout')).AdminLayout }),
    children: [
      { index: true, ...adminPage(() => import('@/routes/admin/dashboard'), 'DashboardPage') },
      { path: 'settings', ...adminPage(() => import('@/routes/admin/settings'), 'SettingsPage') },
      { path: 'rooms', ...adminPage(() => import('@/routes/admin/rooms'), 'RoomsPage') },
      { path: 'users', ...adminPage(() => import('@/routes/admin/users'), 'UsersPage') },
      { path: 'chat', ...adminPage(() => import('@/routes/admin/chat'), 'ChatPage') },
      { path: 'quota', ...adminPage(() => import('@/routes/admin/quota'), 'QuotaPage') },
      { path: 'audit', ...adminPage(() => import('@/routes/admin/audit'), 'AuditPage') },
    ],
  },
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/r/:code', element: <RoomPage /> },
      { path: '/profile', element: <ProfilePage /> },
      { path: '/library', element: <LibraryPage /> },
      { path: '/library/playlists/:id', element: <PlaylistPage /> },
      { path: '/p/:slug', element: <SharedPlaylistPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
