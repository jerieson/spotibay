import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  roomHistoryResponseSchema,
  type PlaylistResponse,
  type PlaybackState,
  type QueueItem,
  type RoomResponse,
  type SkipVotes,
} from '@spotibay/shared';
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
  await h.db.execute('truncate table tracks cascade');
  await h.settings.set('limits.maxQueueItemsPerUser', 5, null);
  await h.settings.set('limits.maxQueueLength', 200, null);
  await h.settings.set('queue.skipVoteThreshold', 0.5, null);
});

const url = (id: string) => `https://youtu.be/${id}`;
/** 11-character video ids: V0 .. V9. */
const vid = (n: number) => `video${String(n).padStart(6, '0')}`;

type Guest = Awaited<ReturnType<Harness['guest']>>;

async function setupRoom() {
  const host = await h.guest();
  const res = await host.api<RoomResponse>('POST', '/rooms', { name: 'Queue room' });
  const code = res.body.room.code;
  const hostSocket = await host.socket();
  await joinRoom(hostSocket, code);
  return { host, hostSocket, code };
}

async function joinAs(guest: Guest, code: string) {
  const socket = await guest.socket();
  const { state } = await joinRoom(socket, code);
  return { guest, socket, state: state! };
}

/** The room snapshot as a new join would see it. */
async function joinFresh(code: string) {
  return (await joinAs(await h.guest(), code)).state;
}

async function roomId(code: string): Promise<string> {
  return (await h.rooms.findByCode(code))!.id;
}

const ids = (items: QueueItem[]) => items.map((i) => i.track.videoId);
const queueIs = (socket: ClientSocket, expected: string[]) =>
  next(socket, 'queue:updated', (q) => ids(q.queue).join() === expected.join());

/** Adds each video in turn, waiting for the server to take it. The first one starts playing. */
async function addAll(socket: ClientSocket, videos: string[]) {
  for (const v of videos) {
    h.videos.set(v, { durationSec: 300 });
    const started = next(socket, 'playback:state', (s) => s.item?.track.videoId === v);
    const queued = next(socket, 'queue:updated', (q) => ids(q.queue).includes(v));
    socket.emit('queue:add', { url: url(v) });
    await Promise.race([started, queued]);
    // Whichever lost the race never fires (or fires later); don't leave a rejection behind.
    started.catch(() => undefined);
    queued.catch(() => undefined);
  }
}

describe('duplicates', () => {
  it('rejects a video that is queued or playing', async () => {
    const { hostSocket } = await setupRoom();
    await addAll(hostSocket, [vid(1), vid(2)]);
    for (const v of [vid(1), vid(2)]) {
      const err = next(hostSocket, 'error');
      hostSocket.emit('queue:add', { url: url(v) });
      expect((await err).code).toBe('duplicate_track');
    }
  });

  it('allows the same video again once it is gone from the queue', async () => {
    const { hostSocket, code } = await setupRoom();
    await addAll(hostSocket, [vid(1), vid(2)]);
    const [queued] = (await joinFresh(code)).queue;
    const gone = queueIs(hostSocket, []);
    hostSocket.emit('queue:remove', { queueItemId: queued!.id });
    await gone;
    const again = queueIs(hostSocket, [vid(2)]);
    hostSocket.emit('queue:add', { url: url(vid(2)) });
    await again;
  });
});

describe('votes', () => {
  it('orders a fifo queue by score, then by when it was added', async () => {
    const { host, hostSocket, code } = await setupRoom();
    await addAll(hostSocket, [vid(1), vid(2), vid(3), vid(4)]);
    const state = await joinFresh(code);
    const [two, , four] = state.queue;
    expect(ids(state.queue)).toEqual([vid(2), vid(3), vid(4)]);

    const up = queueIs(hostSocket, [vid(4), vid(2), vid(3)]);
    hostSocket.emit('queue:vote', { queueItemId: four!.id, value: 1 });
    const after = await up;
    expect(after.queue[0]?.votes).toEqual({ [host.user.id]: 1 });

    const down = queueIs(hostSocket, [vid(4), vid(3), vid(2)]);
    hostSocket.emit('queue:vote', { queueItemId: two!.id, value: -1 });
    await down;

    // Clearing a vote puts the item back where its position says.
    const cleared = queueIs(hostSocket, [vid(4), vid(2), vid(3)]);
    hostSocket.emit('queue:vote', { queueItemId: two!.id, value: 0 });
    await cleared;
  });

  it('counts one vote per user and lets them change it', async () => {
    const { host, hostSocket, code } = await setupRoom();
    await addAll(hostSocket, [vid(1), vid(2)]);
    const state = (await joinAs(await h.guest(), code)).state;
    const item = state.queue[0]!;

    const first = next(hostSocket, 'queue:updated');
    hostSocket.emit('queue:vote', { queueItemId: item.id, value: 1 });
    expect((await first).queue[0]?.votes).toEqual({ [host.user.id]: 1 });

    const flipped = next(hostSocket, 'queue:updated');
    hostSocket.emit('queue:vote', { queueItemId: item.id, value: -1 });
    expect((await flipped).queue[0]?.votes).toEqual({ [host.user.id]: -1 });
  });

  it('rejects an invalid vote value', async () => {
    const { hostSocket } = await setupRoom();
    const err = next(hostSocket, 'error');
    hostSocket.emit('queue:vote', { queueItemId: 'x', value: 5 } as never);
    expect((await err).code).toBe('invalid_payload');
  });
});

describe('fair mode', () => {
  it('interleaves users, ignores votes and follows the host switching modes', async () => {
    const { hostSocket, code } = await setupRoom();
    const { socket: guestSocket } = await joinAs(await h.guest(), code);
    await addAll(hostSocket, [vid(1), vid(2), vid(3)]); // vid(1) plays; host has 2 and 3 queued
    await addAll(guestSocket, [vid(4)]);

    const state = await joinFresh(code);
    expect(ids(state.queue)).toEqual([vid(2), vid(3), vid(4)]);

    // The host's track is playing, so the guest's track goes first.
    const fair = queueIs(hostSocket, [vid(4), vid(2), vid(3)]);
    const updated = next(hostSocket, 'room:updated');
    hostSocket.emit('room:update', { queueMode: 'fair' });
    await fair;
    expect((await updated).room.queueMode).toBe('fair');

    // Votes are display-only in fair mode: a vote changes the score but not the order.
    const liked = state.queue[1]!;
    const voted = next(hostSocket, 'queue:updated');
    hostSocket.emit('queue:vote', { queueItemId: liked.id, value: 1 });
    expect(ids((await voted).queue)).toEqual([vid(4), vid(2), vid(3)]);

    // Back in fifo mode the vote for vid(3) counts.
    const fifo = queueIs(hostSocket, [vid(3), vid(2), vid(4)]);
    hostSocket.emit('room:update', { queueMode: 'fifo' });
    await fifo;
  });

  it('plays tracks in fair order', async () => {
    const { hostSocket, code } = await setupRoom();
    const { socket: guestSocket } = await joinAs(await h.guest(), code);
    await addAll(hostSocket, [vid(1), vid(2), vid(3)]);
    await addAll(guestSocket, [vid(4)]);
    const fair = queueIs(hostSocket, [vid(4), vid(2), vid(3)]);
    hostSocket.emit('room:update', { queueMode: 'fair' });
    await fair;

    const skipTo = (video: string) => {
      const p = next(hostSocket, 'playback:state', (s) => s.item?.track.videoId === video);
      hostSocket.emit('playback:skip');
      return p;
    };
    await skipTo(vid(4));
    await skipTo(vid(2));
    await skipTo(vid(3));
  });

  it('only lets the host change the mode', async () => {
    const { code } = await setupRoom();
    const { socket } = await joinAs(await h.guest(), code);
    const err = next(socket, 'error');
    socket.emit('room:update', { queueMode: 'fair' });
    expect((await err).code).toBe('forbidden');
  });
});

describe('vote skip', () => {
  async function roomOfThree() {
    const { hostSocket, code } = await setupRoom();
    const a = await joinAs(await h.guest(), code);
    const b = await joinAs(await h.guest(), code);
    await addAll(hostSocket, [vid(1), vid(2)]);
    return { hostSocket, code, a, b };
  }

  it('skips once votes reach ceil(members × threshold)', async () => {
    const { hostSocket, code, a, b } = await roomOfThree();
    const tally = next(hostSocket, 'playback:skipVotes', (v) => v.voters.length === 1);
    a.socket.emit('playback:voteSkip');
    const first: SkipVotes = await tally;
    expect(first.needed).toBe(2);
    expect(first.voters).toEqual([a.guest.user.id]);

    // The same person voting twice still counts once.
    a.socket.emit('playback:voteSkip');
    await sleep(100);
    expect((await h.playback.snapshot(await roomId(code))).playback.item?.track.videoId).toBe(
      vid(1),
    );

    const skipped = next(hostSocket, 'playback:state', (s) => s.item?.track.videoId === vid(2));
    b.socket.emit('playback:voteSkip');
    await skipped;
  });

  it('starts the next track with no votes', async () => {
    const { hostSocket, a, b } = await roomOfThree();
    const reset = next(
      hostSocket,
      'playback:skipVotes',
      (v) => v.voters.length === 0 && v.queueItemId !== null,
    );
    a.socket.emit('playback:voteSkip');
    b.socket.emit('playback:voteSkip');
    const votes = await reset;
    expect(votes.queueItemId).not.toBeNull();
  });

  it('skips when a member leaves and the remaining votes are enough', async () => {
    const { hostSocket, a, b } = await roomOfThree();
    const one = next(hostSocket, 'playback:skipVotes', (v) => v.voters.length === 1);
    a.socket.emit('playback:voteSkip');
    await one;
    const skipped = next(hostSocket, 'playback:state', (s) => s.item?.track.videoId === vid(2));
    b.socket.disconnect(); // 2 members left: one vote is now enough
    await skipped;
  });

  it('does not count votes from people who left', async () => {
    const { hostSocket, a } = await roomOfThree();
    const one = next(hostSocket, 'playback:skipVotes', (v) => v.voters.length === 1);
    a.socket.emit('playback:voteSkip');
    await one;
    const gone = next(hostSocket, 'playback:skipVotes', (v) => v.voters.length === 0);
    a.socket.disconnect();
    await gone;
  });
});

describe('removing and reordering', () => {
  it('lets people remove their own items but only host and DJs remove others', async () => {
    const { hostSocket, code } = await setupRoom();
    const { socket: guestSocket } = await joinAs(await h.guest(), code);
    await addAll(hostSocket, [vid(1), vid(2)]);
    await addAll(guestSocket, [vid(3)]);
    const state = await joinFresh(code);
    const [hostItem, guestItem] = state.queue;

    const err = next(guestSocket, 'error');
    guestSocket.emit('queue:remove', { queueItemId: hostItem!.id });
    expect((await err).code).toBe('forbidden');

    const own = queueIs(hostSocket, [vid(2)]);
    guestSocket.emit('queue:remove', { queueItemId: guestItem!.id });
    await own;

    const any = queueIs(hostSocket, []);
    hostSocket.emit('queue:remove', { queueItemId: hostItem!.id });
    await any;
  });

  it('does not remove the track that is playing', async () => {
    const { hostSocket, code } = await setupRoom();
    await addAll(hostSocket, [vid(1), vid(2)]);
    const playing = (await h.playback.snapshot(await roomId(code))).playback.item!;
    hostSocket.emit('queue:remove', { queueItemId: playing.id });
    await sleep(150);
    const snap = await h.playback.snapshot(await roomId(code));
    expect(snap.playback.item?.id).toBe(playing.id);
  });

  it('reorders for the host and persists the order', async () => {
    const { hostSocket, code } = await setupRoom();
    await addAll(hostSocket, [vid(1), vid(2), vid(3), vid(4)]);
    const state = await joinFresh(code);
    const last = state.queue[2]!;

    const moved = queueIs(hostSocket, [vid(4), vid(2), vid(3)]);
    hostSocket.emit('queue:reorder', { queueItemId: last.id, toIndex: 0 });
    await moved;

    const fresh = await joinFresh(code);
    expect(ids(fresh.queue)).toEqual([vid(4), vid(2), vid(3)]);

    // New adds still go to the end.
    await addAll(hostSocket, [vid(5)]);
    expect(ids((await joinFresh(code)).queue)).toEqual([vid(4), vid(2), vid(3), vid(5)]);
  });

  it('refuses reorders from listeners, allows DJs', async () => {
    const { hostSocket, code } = await setupRoom();
    const { guest, socket } = await joinAs(await h.guest(), code);
    await addAll(hostSocket, [vid(1), vid(2), vid(3)]);
    const [first] = (await joinFresh(code)).queue;

    const err = next(socket, 'error');
    socket.emit('queue:reorder', { queueItemId: first!.id, toIndex: 1 });
    expect((await err).code).toBe('forbidden');

    hostSocket.emit('room:setRole', { userId: guest.user.id, role: 'dj' });
    await next(socket, 'room:members', (m) =>
      m.members.some((x) => x.userId === guest.user.id && x.role === 'dj'),
    );
    const moved = queueIs(socket, [vid(3), vid(2)]);
    socket.emit('queue:reorder', { queueItemId: first!.id, toIndex: 1 });
    await moved;
  });
});

describe('history', () => {
  it('lists tracks played in the room, newest first, one per video, for members only', async () => {
    const { host, hostSocket, code } = await setupRoom();
    h.videos.set(vid(1), { durationSec: 1 });
    h.videos.set(vid(2), { durationSec: 1 });
    const idle = (s: PlaybackState) => s.status === 'idle';
    const done = next(hostSocket, 'playback:state', idle, 6000);
    hostSocket.emit('queue:add', { url: url(vid(1)) });
    hostSocket.emit('queue:add', { url: url(vid(2)) });
    await done;

    const res = await host.api('GET', `/rooms/${code}/history`);
    expect(res.status).toBe(200);
    const { history } = roomHistoryResponseSchema.parse(res.body);
    expect(history.map((e) => e.track.videoId)).toEqual([vid(2), vid(1)]);

    const outsider = await h.guest();
    expect((await outsider.api('GET', `/rooms/${code}/history`)).status).toBe(403);
  });

  it('leaves skipped tracks out', async () => {
    const { host, hostSocket, code } = await setupRoom();
    await addAll(hostSocket, [vid(1)]);
    const idle = next(hostSocket, 'playback:state', (s) => s.status === 'idle');
    hostSocket.emit('playback:skip');
    await idle;
    const { history } = roomHistoryResponseSchema.parse(
      (await host.api('GET', `/rooms/${code}/history`)).body,
    );
    expect(history).toEqual([]);
  });
});

describe('queue:addMany', () => {
  const vids = (n: number) => Array.from({ length: n }, (_, i) => vid(i + 1));
  const result = (socket: ClientSocket) => next(socket, 'queue:addManyResult');

  beforeEach(() => {
    for (const v of vids(12)) h.videos.set(v, { durationSec: 300 });
  });

  it('queues a playlist in order and starts playback when the room is idle', async () => {
    const { host, hostSocket } = await setupRoom();
    const p = (await host.api<PlaylistResponse>('POST', '/playlists', { name: 'Mix' })).body
      .playlist;
    await host.api('POST', `/playlists/${p.id}/items`, { videoIds: vids(4) });

    const playing = next(hostSocket, 'playback:state', (s) => s.item?.track.videoId === vid(1));
    const res = result(hostSocket);
    hostSocket.emit('queue:addMany', { playlistId: p.id });
    expect(await res).toEqual({ added: 4, duplicates: 0, unplayable: 0, overLimit: 0 });
    await playing;
    const again = result(hostSocket);
    hostSocket.emit('queue:addMany', { playlistId: p.id });
    expect(await again).toEqual({ added: 0, duplicates: 4, unplayable: 0, overLimit: 0 });
  });

  it('holds listeners to the per-user limit but not hosts or DJs', async () => {
    await h.settings.set('limits.maxQueueItemsPerUser', 3, null);
    const { hostSocket, code } = await setupRoom();
    const { guest, socket } = await joinAs(await h.guest(), code);

    const first = result(socket);
    socket.emit('queue:addMany', { videoIds: vids(5) });
    // The first track starts playing, so the guest keeps 3 queued and 1 more is over the limit.
    expect(await first).toMatchObject({ added: 4, overLimit: 1 });

    const hostRes = result(hostSocket);
    hostSocket.emit('queue:addMany', { videoIds: vids(12).slice(5) });
    expect(await hostRes).toMatchObject({ added: 7, overLimit: 0 });

    hostSocket.emit('room:setRole', { userId: guest.user.id, role: 'dj' });
    await next(socket, 'room:members', (m) =>
      m.members.some((x) => x.userId === guest.user.id && x.role === 'dj'),
    );
    for (const n of [13, 14, 15]) h.videos.set(vid(n), { durationSec: 300 });
    const djRes = result(socket);
    socket.emit('queue:addMany', { videoIds: [vid(13), vid(14), vid(15)] });
    expect(await djRes).toMatchObject({ added: 3, overLimit: 0 });
  });

  it('applies the room-wide limit to everyone', async () => {
    await h.settings.set('limits.maxQueueLength', 3, null);
    const { hostSocket } = await setupRoom();
    const res = result(hostSocket);
    hostSocket.emit('queue:addMany', { videoIds: vids(5) });
    expect(await res).toMatchObject({ added: 3, overLimit: 2 });
  });

  it('counts unplayable tracks', async () => {
    h.videos.set(vid(2), { durationSec: 300, embeddable: false });
    // Live streams have no duration.
    h.videos.set(vid(3), { durationSec: 0 });
    const { hostSocket } = await setupRoom();
    const res = result(hostSocket);
    hostSocket.emit('queue:addMany', { videoIds: [vid(1), vid(2), vid(3), 'zzzzzzzzzzz'] });
    expect(await res).toEqual({ added: 1, duplicates: 0, unplayable: 3, overLimit: 0 });
  });

  it('only queues own or public playlists and validates the payload', async () => {
    const { hostSocket } = await setupRoom();
    const other = await h.guest();
    const p = (await other.api<PlaylistResponse>('POST', '/playlists', { name: 'Theirs' })).body
      .playlist;
    await other.api('POST', `/playlists/${p.id}/items`, { videoIds: [vid(1)] });

    const denied = next(hostSocket, 'error');
    hostSocket.emit('queue:addMany', { playlistId: p.id });
    expect((await denied).code).toBe('playlist_not_found');

    await other.api('PATCH', `/playlists/${p.id}`, { isPublic: true });
    const ok = result(hostSocket);
    hostSocket.emit('queue:addMany', { playlistId: p.id });
    expect(await ok).toMatchObject({ added: 1 });

    for (const bad of [
      {},
      { playlistId: p.id, videoIds: [vid(1)] },
      { videoIds: [] },
      { playlistId: 'nope' },
    ]) {
      const err = next(hostSocket, 'error');
      hostSocket.emit('queue:addMany', bad as never);
      expect((await err).code).toBe('invalid_payload');
    }
  });

  it('needs a room', async () => {
    const g = await h.guest();
    const socket = await g.socket();
    const err = next(socket, 'error');
    socket.emit('queue:addMany', { videoIds: [vid(1)] });
    expect((await err).code).toBe('not_in_room');
  });
});
