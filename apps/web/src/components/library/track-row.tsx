import type { ReactNode } from 'react';
import type { Track } from '@spotibay/shared';
import { formatDuration } from '@/lib/format';

/** Thumbnail, title and channel for a track, with actions on the right. */
export function TrackRow({ track, children }: { track: Track; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 p-2">
      <img src={track.thumbnailUrl} alt="" className="size-10 shrink-0 rounded-md object-cover" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{track.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {track.channelTitle} · {formatDuration(track.durationSec * 1000)}
        </p>
      </div>
      {children}
    </div>
  );
}
