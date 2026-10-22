import type { ClientToServerEvents, ServerToClientEvents } from '@spotibay/shared';

export const PING_BURST = 5;
const PING_SPACING_MS = 150;
export const RESYNC_INTERVAL_MS = 30_000;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** How far the server clock is ahead of ours, from one ping sent at `t0` and answered at `t1`. */
export function clockOffset(t0: number, t1: number, serverTime: number): number {
  return serverTime - (t0 + t1) / 2;
}

interface PingSocket {
  emit(event: 'time:ping', payload: Parameters<ClientToServerEvents['time:ping']>[0]): unknown;
  on(event: 'time:pong', listener: ServerToClientEvents['time:pong']): unknown;
  off(event: 'time:pong', listener: ServerToClientEvents['time:pong']): unknown;
}

/** Estimates the server clock: median offset of a burst of pings, refreshed every 30 s. */
export function createTimeSync(socket: PingSocket, clock: () => number = Date.now) {
  let offset = 0;
  let samples: number[] = [];
  let burstTimers: ReturnType<typeof setTimeout>[] = [];
  let interval: ReturnType<typeof setInterval> | null = null;

  const onPong: ServerToClientEvents['time:pong'] = ({ t0, serverTime }) => {
    samples.push(clockOffset(t0, clock(), serverTime));
    offset = median(samples);
  };

  function burst() {
    samples = [];
    for (let i = 0; i < PING_BURST; i++) {
      burstTimers.push(
        setTimeout(() => socket.emit('time:ping', { t0: clock() }), i * PING_SPACING_MS),
      );
    }
  }

  function start() {
    stop();
    socket.on('time:pong', onPong);
    burst();
    interval = setInterval(burst, RESYNC_INTERVAL_MS);
  }

  function stop() {
    socket.off('time:pong', onPong);
    for (const t of burstTimers) clearTimeout(t);
    burstTimers = [];
    if (interval) clearInterval(interval);
    interval = null;
  }

  return {
    start,
    stop,
    /** Best guess of the server's current epoch ms. */
    now: () => clock() + offset,
    get offset() {
      return offset;
    },
  };
}

export type TimeSync = ReturnType<typeof createTimeSync>;
