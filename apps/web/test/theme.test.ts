import { beforeEach, describe, expect, it } from 'vitest';
import { useThemeStore } from '../src/stores/theme';

describe('theme store', () => {
  beforeEach(() => {
    document.documentElement.classList.add('dark');
    useThemeStore.setState({ theme: 'dark' });
  });

  it('toggles between dark and light and updates the html class', () => {
    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    useThemeStore.getState().toggle();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
