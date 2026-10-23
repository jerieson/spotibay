import { Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { Announcement } from '@spotibay/shared';
import { useSite } from '@/hooks/use-site';
import { cn } from '@/lib/utils';

const levels = {
  info: { icon: Info, className: 'bg-secondary text-secondary-foreground' },
  warning: { icon: TriangleAlert, className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  critical: { icon: OctagonAlert, className: 'bg-destructive/15 text-destructive' },
} satisfies Record<Announcement['level'], unknown>;

export function SiteBanner() {
  const announcement = useSite().data?.announcement;
  if (!announcement) return null;
  const { icon: Icon, className } = levels[announcement.level];
  return (
    <div role="status" className={cn('border-b px-4 py-2 text-sm', className)}>
      <p className="mx-auto flex max-w-5xl items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{announcement.text}</span>
      </p>
    </div>
  );
}
