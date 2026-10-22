import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerToClientEvents } from '@spotibay/shared';
import { clockOffset, createTimeSync, median, PING_BURST } from '../src/lib/time-sync';
import { formatDuration } from '../src/lib/format';

describe('median', () => {
  it('handles odd, even and empty input', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('clockOffset', () => {
  it('assumes the server stamped the reply halfway through the round trip', () => {
    // sent at 1000, received at 1100, server clock read 5050 => server is 4000 ahead
    expect(clockOffset(1000, 1100, 5050)).toBe(4000);
  });
});

describe('createTimeSync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A server whose clock is `skew` ms ahead and whose latency is each entry of `latencies` in turn. */
  function fakeSocket(skew: number, latencies: number[]) {
    let listener: ServerToClientEvents['time:pong'] | null = null;
    let pings = 0;
    return {
      emit: (_event: 'time:ping', { t0 }: { t0: number }) => {
        const latency = latencies[pings++ % latencies.length]!;
        const serverTime = t0 + latency / 2 + skew;
        setTimeout(() => listener?.({ t0, serverTime }), latency);
      },
      on: (_e: 'time:pong', l: ServerToClientEvents['time:pong']) => void (listener = l),
      off: () => void (listener = null),
      get pings() {
        return pings;
      },
    };
  }

  it('settles on the median offset, ignoring one slow outlier', async () => {
    const socket = fakeSocket(2500, [40, 40, 900, 40, 40]);
    const sync = createTimeSync(socket);
    sync.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(socket.pings).toBe(PING_BURST);
    expect(Math.abs(sync.offset - 2500)).toBeLessThan(5);
    expect(Math.abs(sync.now() - (Date.now() + 2500))).toBeLessThan(5);
    sync.stop();
  });

  it('measures again every 30 seconds until stopped', async () => {
    const socket = fakeSocket(0, [10]);
    const sync = createTimeSync(socket);
    sync.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(socket.pings).toBe(PING_BURST * 2);
    sync.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.pings).toBe(PING_BURST * 2);
  });
});

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_900)).toBe('1:05');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(-5)).toBe('0:00');
  });
});
