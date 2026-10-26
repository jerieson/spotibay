import { Check, Copy, Share2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Copies `text`. With a `caption` it shows as a labelled button instead of a bare icon. */
export function CopyButton({
  text,
  label,
  caption,
  className,
}: {
  text: string;
  label: string;
  caption?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (insecure context, denied permission); the text stays selectable.
    }
  }

  if (caption) {
    return (
      <Button
        type="button"
        variant="outline"
        className={cn('rounded-full', className)}
        // The visible caption is the name; the label explains what it does.
        title={label}
        onClick={copy}
      >
        {copied ? <Check className="text-volt-text" /> : <Share2 />}
        <span aria-live="polite">{copied ? 'Link copied!' : caption}</span>
      </Button>
    );
  }

  return (
    <Button type="button" variant="outline" size="icon" aria-label={label} onClick={copy}>
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  );
}
