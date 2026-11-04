import { describe, expect, it } from 'vitest';
import { MAX_BATCH_VIDEOS, type QueueItem } from '@spotibay/shared';
import { initialPicks, queueSlots, videosInRoom } from '../src/lib/queue-slots';

const item = (
  videoId: string,
  userId: string,
  source: QueueItem['source'] = 'user',
): QueueItem => ({
  id: `${videoId}-item`,
  track: { videoId, title: videoId, channelTitle: 'c', thumbnailUrl: 'u', durationSec: 200 },
  addedBy: { userId, displayName: userId, avatar: { style: 'thumbs', seed: 's', options: {} } },
  source,
  votes: {},
});

const playing = { status: 'playing' as const };

describe('queueSlots', () => {
  it('is the limit minus your waiting songs', () => {
    const queue = [item('a', 'me'), item('b', 'other'), item('c', 'me')];
    expect(queueSlots({ role: 'listener', userId: 'me', limit: 5, queue, playback: playing })).toBe(
      3,
    );
  });

  it('never goes below zero', () => {
    const queue = [item('a', 'me'), item('b', 'me')];
    expect(queueSlots({ role: 'listener', userId: 'me', limit: 1, queue, playback: playing })).toBe(
      0,
    );
  });

  it("leaves out autoplay's pick, even though it is credited to someone", () => {
    const queue = [item('a', 'me', 'autoplay')];
    expect(queueSlots({ role: 'listener', userId: 'me', limit: 2, queue, playback: playing })).toBe(
      2,
    );
  });

  it('gives one more on a quiet room, where the first song starts at once', () => {
    expect(
      queueSlots({
        role: 'listener',
        userId: 'me',
        limit: 5,
        queue: [],
        playback: { status: 'idle' },
      }),
    ).toBe(6);
  });

  it('lets the host and DJs fill a whole batch', () => {
    const queue = Array.from({ length: 10 }, (_, i) => item(`v${i}`, 'me'));
    for (const role of ['host', 'dj'] as const) {
      expect(queueSlots({ role, userId: 'me', limit: 1, queue, playback: playing })).toBe(
        MAX_BATCH_VIDEOS,
      );
    }
  });
});

describe('videosInRoom and initialPicks', () => {
  it("counts what's playing and waiting, but not autoplay's pick", () => {
    const inRoom = videosInRoom([item('a', 'x'), item('b', 'x', 'autoplay')], item('p', 'x'));
    expect([...inRoom].sort()).toEqual(['a', 'p']);
  });

  it('ticks the first songs that fit, skipping ones in the room and repeats', () => {
    expect(initialPicks(['a', 'b', 'b', 'c', 'd'], new Set(['a']), 2)).toEqual(['b', 'c']);
    expect(initialPicks(['a', 'b'], new Set(), 0)).toEqual([]);
  });
});
