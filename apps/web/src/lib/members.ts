import type { Member } from '@spotibay/shared';

/** Who arrived and who left between two member lists, ignoring `selfId`. */
export function diffMembers(prev: Member[], next: Member[], selfId: string) {
  const before = new Set(prev.map((m) => m.userId));
  const after = new Set(next.map((m) => m.userId));
  return {
    joined: next.filter((m) => !before.has(m.userId) && m.userId !== selfId),
    left: prev.filter((m) => !after.has(m.userId) && m.userId !== selfId),
  };
}

export const roleLabels = { host: 'Host', dj: 'DJ', listener: 'Listener' } as const;
