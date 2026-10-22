import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { expectedPositionMs, type PlaybackState, type RoomResponse } from '@spotibay/shared';
import { apiQuotaUsage, listenHistory, tracks } from '../src/db/schema.js';
import {
  createHarness,
  joinRoom,
  next,
  sleep,
  type ClientSocket,
  type Harness,
} from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  h.videos.clear();
  h.youtubeCalls.length = 0;
  // Tracks are cached for a day, so tests that reuse an id with a new duration need a clean table.
  await h.db.execute('truncate table tracks cascade');
  await h.settings.set('limits.maxTrackDurationSec', 900, null);
  await h.settings.set('limits.maxQueueItemsPerUser', 5, null);
  await h.settings.set('limits.maxQueueLength', 200, null);
});

const url = (id: string) => `https://youtu.be/${id}`;
const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const C = 'ccccccccccc';

type Guest = Awaited<ReturnType<Harness['guest']>>;

async function setupRoom() {
  const host = await h.guest();
  const res = await host.api<RoomResponse>('POST', '/rooms', { name: 'Sync room' });
  const code = res.body.room.code;
  const hostSocket = await host.socket();
  const { state } = await joinRoom(hostSocket, code);
  return { host, hostSocket, code, state: state! };
}

async function joinAs(guest: Guest, code: string) {
  const socket = await guest.socket();
  const { state } = await joinRoom(socket, code);
  return { socket, state: state! };
}

const playbackWith = (socket: ClientSocket, pred: (s: PlaybackState) => boolean) =>
  next(socket, 'playback:state', pred);

describe('adding tracks by link', () => {
  it('starts the first track at once and queues the rest', async () => {
    h.videos.set(A, { durationSec: 200 });
    h.videos.set(B, { durationSec: 200 });
    const { hostSocket, state } = await setupRoom();
    expect(state.playback.status).toBe('idle');
    expect(state.queue).toEqual([]);

    const started = playbackWith(hostSocket, (s) => s.status === 'playing');
    hostSocket.emit('queue:add', { url: url(A) });
    const playing = await started;
    expect(playing.item?.track).toMatchObject({ videoId: A, durationSec: 200 });
    expect(playing.positionMs).toBe(0);

    const queued = next(hostSocket, 'queue:updated', (q) => q.queue.length === 1);
    hostSocket.emit('queue:add', { url: `https://music.youtube.com/watch?v=${B}` });
    expect((await queued).queue[0]?.track.videoId).toBe(B);
  });

  it('records quota for the videos.list call and reuses stored tracks', async () => {
    h.videos.set(A, { durationSec: 100 });
    const { hostSocket } = await setupRoom();
    await h.db.delete(apiQuotaUsage);
    const started = playbackWith(hostSocket, (s) => s.status === 'playing');
    hostSocket.emit('queue:add', { url: url(A) });
    await started;
    const [row] = await h.db.select().from(apiQuotaUsage);
    expect(row?.units).toBe(1);

    // A second add of the same video is a duplicate, and is checked against the stored track.
    const err = next(hostSocket, 'error');
    hostSocket.emit('queue:add', { url: url(A) });
    expect((await err).code).toBe('duplicate_track');
    expect(h.youtubeCalls.filter((c) => c.includes(A))).toHaveLength(1);
  });

  it.each([
    ['garbage', 'not a link', 'invalid_video'],
    ['unknown video', url('zzzzzzzzzzz'), 'invalid_video'],
  ])('rejects %s', async (_name, link, code) => {
    const { hostSocket } = await setupRoom();
    const err = next(hostSocket, 'error');
    hostSocket.emit('queue:add', { url: link });
    expect((await err).code).toBe(code);
  });

  it('rejects over-long, live and non-embeddable videos', async () => {
    h.videos.set(A, { durationSec: 901 });
    h.videos.set(B, { durationSec: 0 });
    h.videos.set(C, { durationSec: 60, embeddable: false });
    const { hostSocket } = await setupRoom();
    for (const id of [A, B, C]) {
      const err = next(hostSocket, 'error');
      hostSocket.emit('queue:add', { url: url(id) });
      expect((await err).code).toBe('track_rejected');
    }
    await h.settings.set('limits.maxTrackDurationSec', 1000, null);
    h.videos.set(A, { durationSec: 901 });
    const ok = playbackWith(hostSocket, (s) => s.status === 'playing');
    hostSocket.emit('queue:add', { url: url(A) });
    await ok;
  });

  it('enforces per-user and total queue limits', async () => {
    h.videos.set(A, { durationSec: 100 });
    h.videos.set(B, { durationSec: 100 });
    h.videos.set(C, { durationSec: 100 });
    await h.settings.set('limits.maxQueueItemsPerUser', 1, null);
    const { hostSocket, code } = await setupRoom();
    const first = playbackWith(hostSocket, (s) => s.status === 'playing');
    hostSocket.emit('queue:add', { url: url(A) }); // plays at once, so it is not "queued"
    await first;
    const queued = next(hostSocket, 'queue:updated');
    hostSocket.emit('queue:add', { url: url(B) });
    await queued;
    const err = next(hostSocket, 'error');
    hostSocket.emit('queue:add', { url: url(C) });
    expect((await err).code).toBe('queue_limit');

    await h.settings.set('limits.maxQueueLength', 2, null);
    const { socket: other } = await joinAs(await h.guest(), code);
    const full = next(other, 'error');
    other.emit('queue:add', { url: url(C) });
    expect((await full).message).toMatch(/full/);
  });

  it('validates the payload', async () => {
    const { hostSocket } = await setupRoom();
    const err = next(hostSocket, 'error');
    (hostSocket as ClientSocket).emit('queue:add', { url: 42 } as never);
    expect((await err).code).toBe('invalid_payload');
  });
});

describe('controls', () => {
  it('lets the host pause, seek, resume and skip, and tells everyone', async () => {
    h.videos.set(A, { durationSec: 300 });
    h.videos.set(B, { durationSec: 300 });
    const { hostSocket, code } = await setupRoom();
    const { socket: listener } = await joinAs(await h.guest(), code);

    const started = playbackWith(listener, (s) => s.status === 'playing');
    hostSocket.emit('queue:add', { url: url(A) });
    hostSocket.emit('queue:add', { url: url(B) });
    await started;

    await sleep(150);
    const paused = playbackWith(listener, (s) => s.status === 'paused');
    hostSocket.emit('playback:pause');
    const p = await paused;
    expect(p.positionMs).toBeGreaterThanOrEqual(100);
    expect(p.positionMs).toBeLessThan(2000);

    const seeked = playbackWith(listener, (s) => s.positionMs === 60_000);
    hostSocket.emit('playback:seek', { positionMs: 60_000 });
    expect((await seeked).status).toBe('paused');

    const resumed = playbackWith(listener, (s) => s.status === 'playing');
    hostSocket.emit('playback:play');
    const r = await resumed;
    expect(r.positionMs).toBe(60_000);
    expect(r.version).toBeGreaterThan(p.version);

    const skipped = playbackWith(listener, (s) => s.item?.track.videoId === B);
    hostSocket.emit('playback:skip');
    expect((await skipped).positionMs).toBe(0);

    const idle = playbackWith(listener, (s) => s.status === 'idle');
    hostSocket.emit('playback:skip');
    await idle;
  });

  it('clamps seeks to the track length', async () => {
    h.videos.set(A, { durationSec: 120 });
    const { hostSocket } = await setupRoom();
    const started = playbackWith(hostSocket, (s) => s.status === 'playing');
    hostSocket.emit('queue:add', { url: url(A) });
    await started;
    const seeked = playbackWith(hostSocket, (s) => s.positionMs > 0);
    hostSocket.emit('playback:seek', { positionMs: 9_999_999 });
    expect((await seeked).positionMs).toBe(120_000);
  });

  it('refuses listeners but allows DJs', async () => {
    h.videos.set(A, { durationSec: 300 });
    const { hostSocket, code } = await setupRoom();
    const guest = await h.guest();
    const { socket: listener } = await joinAs(guest, code);
    const started = playbackWith(hostSocket, (s) => s.status === 'playing');
    hostSocket.emit('queue:add', { url: url(A) });
    await started;

    for (const send of [
      () => listener.emit('playback:pause'),
      () => listener.emit('playback:skip'),
      () => listener.emit('playback:seek', { positionMs: 1000 }),
    ]) {
      const err = next(listener, 'error');
      send();
      expect((await err).code).toBe('forbidden');
    }

    const promoted = next(listener, 'room:members', (m) =>
      m.members.some((x) => x.userId === guest.user.id && x.role === 'dj'),
    );
    hostSocket.emit('room:setRole', { userId: guest.user.id, role: 'dj' });
    await promoted;
    const paused = playbackWith(hostSocket, (s) => s.status === 'paused');
    listener.emit('playback:pause');
    await paused;
  });

  it('listeners can still add tracks', async () => {
    h.videos.set(A, { durationSec: 300 });
    const { code } = await setupRoom();
    const { socket: listener } = await joinAs(await h.guest(), code);
    const started = playbackWith(listener, (s) => s.status === 'playing');
    listener.emit('queue:add', { url: url(A) });
    expect((await started).item?.addedBy.displayName).toBeTruthy();
  });
});

describe('sync', () => {
  it('gives a late joiner the right position', async () => {
    h.videos.set(A, { durationSec: 300 });
    h.videos.set(B, { durationSec: 300 });
    const { hostSocket, code } = await setupRoom();
    const started = playbackWith(hostSocket, (s) => s.status === 'playing');
    hostSocket.emit('queue:add', { url: url(A) });
    await started;
    const queued = next(hostSocket, 'queue:updated');
    hostSocket.emit('queue:add', { url: url(B) });
    await queued;
    await sleep(400);

    const { state } = await joinAs(await h.guest(), code);
    expect(state.playback.status).toBe('playing');
    expect(state.playback.item?.track.videoId).toBe(A);
    expect(state.queue.map((q) => q.track.videoId)).toEqual([B]);
    expect(state.sync).toEqual({ driftThresholdMs: 600, checkIntervalMs: 2000 });
    const pos = expectedPositionMs(state.playback, Date.now());
    expect(pos).toBeGreaterThanOrEqual(400);
    expect(pos).toBeLessThan(3000);
  });

  it('advances on its own when a track ends and records listening history', async () => {
    h.videos.set(A, { durationSec: 1 });
    h.videos.set(B, { durationSec: 300 });
    const { host, hostSocket, code } = await setupRoom();
    const guest = await h.guest();
    await joinAs(guest, code);

    const started = playbackWith(hostSocket, (s) => s.item?.track.videoId === A);
    hostSocket.emit('queue:add', { url: url(A) });
    hostSocket.emit('queue:add', { url: url(B) });
    await started;
    const advanced = await playbackWith(hostSocket, (s) => s.item?.track.videoId === B);
    expect(advanced.status).toBe('playing');
    expect(advanced.positionMs).toBe(0);

    const history = await h.db.select().from(listenHistory).where(eq(listenHistory.videoId, A));
    expect(history.map((r) => r.userId).sort()).toEqual([host.user.id, guest.user.id].sort());
  });

  it('goes idle when the last track ends', async () => {
    h.videos.set(A, { durationSec: 1 });
    const { hostSocket } = await setupRoom();
    const started = playbackWith(hostSocket, (s) => s.status === 'playing');
    hostSocket.emit('queue:add', { url: url(A) });
    await started;
    const idle = await playbackWith(hostSocket, (s) => s.status === 'idle');
    expect(idle.item).toBeNull();
  });

  it('does not end a paused track, and resumes the timer with the remaining time', async () => {
    h.videos.set(A, { durationSec: 2 });
    const { hostSocket } = await setupRoom();
    const started = playbackWith(hostSocket, (s) => s.status === 'playing');
    hostSocket.emit('queue:add', { url: url(A) });
    await started;
    const paused = playbackWith(hostSocket, (s) => s.status === 'paused');
    hostSocket.emit('playback:pause');
    await paused;
    await sleep(2300);
    const resumed = playbackWith(hostSocket, (s) => s.status === 'playing');
    hostSocket.emit('playback:play');
    await resumed;
    const idle = await playbackWith(hostSocket, (s) => s.status === 'idle');
    expect(idle.version).toBeGreaterThan(0);
  });

  it('rebuilds end timers from Redis after a restart', async () => {
    h.videos.set(A, { durationSec: 1 });
    h.videos.set(B, { durationSec: 300 });
    const { hostSocket } = await setupRoom();
    const started = playbackWith(hostSocket, (s) => s.status === 'playing');
    hostSocket.emit('queue:add', { url: url(A) });
    hostSocket.emit('queue:add', { url: url(B) });
    await started;
    // A restart loses in-process timers but keeps Redis; `start` must put them back.
    h.playback.stop();
    await sleep(1200);
    const advanced = playbackWith(hostSocket, (s) => s.item?.track.videoId === B);
    await h.playback.start();
    expect((await advanced).status).toBe('playing');
  });
});

describe('unavailable videos', () => {
  it('marks the track unplayable and skips once', async () => {
    h.videos.set(A, { durationSec: 300 });
    h.videos.set(B, { durationSec: 300 });
    const { hostSocket, code } = await setupRoom();
    const { socket: listener } = await joinAs(await h.guest(), code);
    const started = playbackWith(listener, (s) => s.item?.track.videoId === A);
    hostSocket.emit('queue:add', { url: url(A) });
    hostSocket.emit('queue:add', { url: url(B) });
    const first = await started;

    const skipped = playbackWith(listener, (s) => s.item?.track.videoId === B);
    listener.emit('playback:reportUnavailable', { queueItemId: first.item!.id });
    hostSocket.emit('playback:reportUnavailable', { queueItemId: first.item!.id });
    await skipped;
    await sleep(150);

    // The second report names an item that is no longer playing, so B must still be playing.
    const [track] = await h.db.select().from(tracks).where(eq(tracks.videoId, A));
    expect(track?.embeddable).toBe(false);
    const { state } = await joinAs(await h.guest(), code);
    expect(state.playback.item?.track.videoId).toBe(B);
    expect(state.playback.status).toBe('playing');
  });
});

describe('room listing', () => {
  it('shows what a room is playing', async () => {
    h.videos.set(A, { durationSec: 300, title: 'Never Gonna' });
    const { host, hostSocket, code } = await setupRoom();
    const started = playbackWith(hostSocket, (s) => s.status === 'playing');
    hostSocket.emit('queue:add', { url: url(A) });
    await started;
    const res = await host.api<RoomResponse>('GET', `/rooms/${code}`);
    expect(res.body.room.nowPlaying).toMatchObject({ videoId: A, title: 'Never Gonna' });
  });
});
