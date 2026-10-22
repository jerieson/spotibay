import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { User } from '@spotibay/shared';
import { recoverSession, regenerateRecoveryCode, startSession, updateMe } from '@/lib/api';
import { useRecoveryStore } from '@/stores/recovery';

export const sessionKey = ['session'] as const;

/** Resolves the current guest, creating one on first visit. */
export function useSession() {
  return useQuery({
    queryKey: sessionKey,
    queryFn: async () => {
      const res = await startSession();
      if (res.recoveryCode) useRecoveryStore.getState().setCode(res.recoveryCode);
      return res.user;
    },
    staleTime: Infinity,
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: updateMe,
    onSuccess: (user) => qc.setQueryData<User>(sessionKey, user),
  });
}

export function useRecoverAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: recoverSession,
    onSuccess: (res) => {
      useRecoveryStore.setState({ code: null, unacknowledged: false });
      qc.clear();
      qc.setQueryData<User>(sessionKey, res.user);
    },
  });
}

export function useRegenerateRecoveryCode() {
  return useMutation({
    mutationFn: regenerateRecoveryCode,
    onSuccess: (code) => useRecoveryStore.getState().setCode(code),
  });
}
