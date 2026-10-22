import { create } from 'zustand';

export type Theme = 'dark' | 'light';

function readStoredTheme(): Theme {
  try {
    return localStorage.getItem('theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // storage unavailable (private mode); theme still applies for this session
  }
}

type ThemeState = { theme: Theme; toggle: () => void };

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readStoredTheme(),
  toggle: () => {
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    set({ theme: next });
  },
}));
