import { useQuery } from '@tanstack/react-query';
import { fetchSite } from '@/lib/api';

export const siteKey = ['site'] as const;

/** Maintenance flag and announcement. Sockets push changes while a room is open; otherwise it polls. */
export function useSite() {
  return useQuery({
    queryKey: siteKey,
    queryFn: fetchSite,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
