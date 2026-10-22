import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useThemeStore } from '@/stores/theme';

export function Toaster(props: ToasterProps) {
  const theme = useThemeStore((s) => s.theme);
  return (
    <Sonner
      theme={theme}
      position="top-center"
      toastOptions={{ classNames: { toast: 'border bg-card text-card-foreground' } }}
      {...props}
    />
  );
}
