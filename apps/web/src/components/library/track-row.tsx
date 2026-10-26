import type { ReactNode } from 'react';
import type { Track } from '@spotibay/shared';
import { TrackText } from '@/components/track-text';
import { formatDuration } from '@/lib/format';

/** Thumbnail, title and channel for a track, with actions on the right. */
export function TrackRow({ track, children }: { track: Track; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 p-2">
      <img src={track.thumbnailUrl} alt="" className="size-10 shrink-0 rounded-md object-cover" />
      <TrackText
        title={track.title}
        detail={`${track.channelTitle} · ${formatDuration(track.durationSec * 1000)}`}
      />
      {children}
    </div>
  );
}
