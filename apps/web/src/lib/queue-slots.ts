import {
  MAX_BATCH_VIDEOS,
  type PlaybackState,
  type QueueItem,
  type RoomRole,
} from '@spotibay/shared';

export interface QueueSlotsInput {
  role: RoomRole;
  userId: string;
  /** Songs a listener may have waiting at once. */
  limit: number;
  queue: QueueItem[];
  playback: Pick<PlaybackState, 'status'>;
}

/**
 * How many more songs this person can queue in one go, as the server counts them in `addMany`:
 * their own waiting songs count (autoplay's pick doesn't), and on a quiet room the first song
 * starts at once instead of waiting. The host and DJs have no per-person limit, but one batch is
 * still at most `MAX_BATCH_VIDEOS`.
 */
export function queueSlots({ role, userId, limit, queue, playback }: QueueSlotsInput): number {
  if (role !== 'listener') return MAX_BATCH_VIDEOS;
  const mine = queue.filter((i) => i.source !== 'autoplay' && i.addedBy.userId === userId).length;
  const startsNow = playback.status === 'idle' ? 1 : 0;
  return Math.min(MAX_BATCH_VIDEOS, Math.max(0, limit - mine + startsNow));
}

/** Videos the room already has, playing or waiting; queueing them again would be refused. */
export function videosInRoom(queue: QueueItem[], playing: QueueItem | null): Set<string> {
  // Autoplay's pick makes way for whatever a person adds, so it doesn't block the same song.
  const ids = queue.filter((i) => i.source !== 'autoplay').map((i) => i.track.videoId);
  if (playing) ids.push(playing.track.videoId);
  return new Set(ids);
}

/**
 * The songs ticked when the picker opens: the first `slots` the room doesn't already have, in
 * order, without repeats.
 */
export function initialPicks(videoIds: string[], inRoom: Set<string>, slots: number): string[] {
  const picks: string[] = [];
  for (const id of videoIds) {
    if (picks.length >= slots) break;
    if (!inRoom.has(id) && !picks.includes(id)) picks.push(id);
  }
  return picks;
}
