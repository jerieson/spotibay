import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tracking-wide uppercase',
  {
    variants: {
      variant: {
        default: 'bg-secondary text-secondary-foreground',
        host: 'bg-volt text-ink',
        outline: 'text-foreground ring-1 ring-border',
        destructive: 'bg-destructive/15 text-destructive',
        dj: 'bg-volt/20 text-foreground ring-1 ring-volt/60',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge };
