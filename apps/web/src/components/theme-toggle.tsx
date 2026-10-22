import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useThemeStore } from '@/stores/theme';

export function ThemeToggle() {
  const { theme, toggle } = useThemeStore();
  return (
    <Button variant="outline" size="icon" onClick={toggle} aria-label="Toggle dark mode">
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  );
}
