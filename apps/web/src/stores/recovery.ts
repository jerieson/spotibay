import { create } from 'zustand';

/**
 * The recovery code only exists client-side right after it is created or regenerated;
 * the server keeps just a hash. It lives in memory only, so a reload forgets it.
 */
interface RecoveryState {
  code: string | null;
  /** True until the person dismisses the "save your code" dialog. */
  unacknowledged: boolean;
  setCode: (code: string) => void;
  acknowledge: () => void;
}

export const useRecoveryStore = create<RecoveryState>((set) => ({
  code: null,
  unacknowledged: false,
  setCode: (code) => set({ code, unacknowledged: true }),
  acknowledge: () => set({ unacknowledged: false }),
}));
