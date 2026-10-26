import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * A title and a detail line cut to fit a row. Hovering or focusing shows both in full; touch
 * screens have no hover, so there the title wraps onto a second line instead.
 */
export function TrackText({ title, detail }: { title: string; detail: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="min-w-0 flex-1 cursor-default rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          tabIndex={0}
        >
          <p className="truncate text-sm font-medium [@media(hover:none)]:line-clamp-2 [@media(hover:none)]:whitespace-normal">
            {title}
          </p>
          <p className="truncate text-sm text-muted-foreground">{detail}</p>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-xs">
        <p className="font-medium break-words">{title}</p>
        <p className="break-words opacity-80">{detail}</p>
      </TooltipContent>
    </Tooltip>
  );
}
