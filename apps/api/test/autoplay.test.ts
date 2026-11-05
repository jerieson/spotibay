import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { QueueItem, Room, RoomResponse } from '@spotibay/shared';
import { catalogMatches, queueItems, tracks } from '../src/db/schema.js';
import { createHarness, joinRoom, next, sleep, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const BENBEN = '2';
/** 11-character video ids. */
const KATHANG = 'kathang0000';
const MAYBE = 'maybenight0';
const GUSTO = 'gusto000000';
const MAHIKA = 'mahika00000';
const OTHER = 'othersong00';

beforeEach(async () => {
  await h.redis.flushdb();
  await h.db.execute('truncate table tracks, rooms, api_quota_usage cascade');
  for (const m of [h.catalogSongs, h.artistRadios, h.songLinks, h.videos, h.searchResults]) {
    m.clear();
  }
  h.deezerChart.length = 0;
  h.searchCalls.length = 0;
  h.songLinkCalls.length = 0;
  await h.settings.set('features.catalogSearch', true, null);
  await h.settings.set('features.autoplay', true, null);
  await h.settings.set('limits.maxQueueItemsPerUser', 5, null);
  // Most tests check the free ways; the ones about searching turn it on.
  await h.settings.set('search.autoplaySearchesPerDay', 0, null);
  await h.settings.set('search.dailySearchCallBudget', 95, null);

  const song = (id: string, title: string) =>
    h.catalogSongs.set(id, { title, artist: 'Ben&Ben', artistId: BENBEN, durationSec: 240 });
  song('201', 'Kathang Isip');
  song('202', 'Maybe the Night');
  song('203', 'Pagtingin');
  song('204', 'Araw-Araw');
  h.artistRadios.set(BENBEN, ['202', '203', '204']);
  // 203 has no link anywhere, so it can only be found by a YouTube search, which autoplay never runs.
  h.songLinks.set('202', { youtubeMusic: MAYBE });
  h.songLinks.set('204', { youtubeMusic: GUSTO });
  const video = (id: string, title: string) =>
    h.videos.set(id, { title, channelTitle: 'Ben&Ben - Topic', durationSec: 240 });
  video(KATHANG, 'Kathang Isip');
  video(MAYBE, 'Maybe the Night');
  video(GUSTO, 'Araw-Araw');
  video(MAHIKA, 'Mahika');
  video(OTHER, 'Something else');
  // The first song is already known to the catalog, so the room's taste is Ben&Ben.
  await h.db.insert(tracks).values({
    videoId: KATHANG,
    title: 'Kathang Isip',
    channelTitle: 'Ben&Ben',
    durationSec: 240,
    thumbnailUrl: 'https://i.ytimg.com/x.jpg',
    catalogId: '201',
  });
});

async function setupRoom() {
  const host = await h.guest();
  const res = await host.api<RoomResponse>('POST', '/rooms', { name: 'Autoplay room' });
  const code = res.body.room.code;
  const socket = await host.socket();
  await joinRoom(socket, code);
  const roomId = (await h.rooms.findByCode(code))!.id;
  return { host, socket, code, roomId };
}

type Setup = Awaited<ReturnType<typeof setupRoom>>;

async function setAutoplay({ socket }: Setup, on: boolean): Promise<Room> {
  const updated = next(socket, 'room:updated', (u) => u.room.autoplay === on);
  socket.emit('room:update', { autoplay: on });
  return (await updated).room;
}

const ids = (items: QueueItem[]) => items.map((i) => i.track.videoId);

describe('autoplay', () => {
  it('is off in a new room and only the host can turn it on', async () => {
    const setup = await setupRoom();
    expect((await h.rooms.findById(setup.roomId))!.autoplay).toBe(false);
    const listener = await h.guest();
    const socket = await listener.socket();
    await joinRoom(socket, setup.code);
    const err = next(socket, 'error');
    socket.emit('room:update', { autoplay: true });
    expect((await err).code).toBe('forbidden');
    expect((await setAutoplay(setup, true)).autoplay).toBe(true);
  });

  it('queues a related song when nothing is next, credited to the host, without a search', async () => {
    const setup = await setupRoom();
    await setAutoplay(setup, true);
    const queued = next(setup.socket, 'queue:updated', (q) => q.queue.length > 0);
    setup.socket.emit('queue:add', { url: `https://youtu.be/${KATHANG}` });
    const [pick] = (await queued).queue;
    expect(pick?.track.videoId).toBe(MAYBE);
    expect(pick?.source).toBe('autoplay');
    expect(pick?.addedBy.userId).toBe(setup.host.user.id);
    expect(h.searchCalls).toEqual([]);
  });

  it('steps aside when a person adds a song, and does not count against their limit', async () => {
    const setup = await setupRoom();
    await setAutoplay(setup, true);
    await h.settings.set('limits.maxQueueItemsPerUser', 1, null);
    const picked = next(setup.socket, 'queue:updated', (q) => ids(q.queue).join() === MAYBE);
    setup.socket.emit('queue:add', { url: `https://youtu.be/${KATHANG}` });
    await picked;

    const replaced = next(setup.socket, 'queue:updated', (q) => ids(q.queue).join() === OTHER);
    setup.socket.emit('queue:add', { url: `https://youtu.be/${OTHER}` });
    const [mine] = (await replaced).queue;
    expect(mine?.source).toBe('user');
  });

  it('starts a quiet room when turned on, then queues the song after it', async () => {
    const setup = await setupRoom();
    await h.db.insert(queueItems).values({
      roomId: setup.roomId,
      videoId: KATHANG,
      addedBy: setup.host.user.id,
      position: 1,
      status: 'played',
      startedAt: new Date(),
    });
    const started = next(setup.socket, 'playback:state', (s) => s.item?.track.videoId === MAYBE);
    const after = next(setup.socket, 'queue:updated', (q) => ids(q.queue).join() === GUSTO);
    await setAutoplay(setup, true);
    expect((await started).item?.source).toBe('autoplay');
    // 203 can't be matched without a search, so it's passed over for 204.
    expect((await after).queue[0]?.source).toBe('autoplay');
    expect(h.searchCalls).toEqual([]);
  });

  it('does nothing when the room or the admin has it off', async () => {
    const setup = await setupRoom();
    const started = next(setup.socket, 'playback:state', (s) => s.item?.track.videoId === KATHANG);
    setup.socket.emit('queue:add', { url: `https://youtu.be/${KATHANG}` });
    await started;
    await h.autoplay.fill(setup.roomId);
    expect((await h.playback.snapshot(setup.roomId)).queue).toEqual([]);

    await h.settings.set('features.autoplay', false, null);
    await setAutoplay(setup, true);
    await h.autoplay.fill(setup.roomId);
    expect((await h.playback.snapshot(setup.roomId)).queue).toEqual([]);
    expect(h.songLinkCalls).toEqual([]);
  });

  it('queues nothing when no song can be matched without a search', async () => {
    h.songLinks.clear();
    const setup = await setupRoom();
    await setAutoplay(setup, true);
    const started = next(setup.socket, 'playback:state', (s) => s.item?.track.videoId === KATHANG);
    setup.socket.emit('queue:add', { url: `https://youtu.be/${KATHANG}` });
    await started;
    await sleep(100);
    await h.autoplay.fill(setup.roomId);
    expect((await h.playback.snapshot(setup.roomId)).queue).toEqual([]);
    expect(h.searchCalls).toEqual([]);
  });

  it('takes a song someone already matched before asking the link sources', async () => {
    await h.db.insert(tracks).values({
      videoId: MAHIKA,
      title: 'Mahika',
      channelTitle: 'Ben&Ben',
      durationSec: 240,
      thumbnailUrl: 'https://i.ytimg.com/x.jpg',
    });
    // 203 has no link, but someone matched it before, so it's free and goes first.
    await h.db.insert(catalogMatches).values({ catalogId: '203', videoId: MAHIKA });
    const setup = await setupRoom();
    await setAutoplay(setup, true);
    const queued = next(setup.socket, 'queue:updated', (q) => q.queue.length > 0);
    setup.socket.emit('queue:add', { url: `https://youtu.be/${KATHANG}` });
    expect(ids((await queued).queue)).toEqual([MAHIKA]);
    expect(h.songLinkCalls).toEqual([]);
    expect(h.searchCalls).toEqual([]);
  });

  it('spends a search when nothing free is found, and remembers the match', async () => {
    h.songLinks.clear();
    await h.settings.set('search.autoplaySearchesPerDay', 5, null);
    h.searchResults.set('ben&ben maybe the night', [OTHER, MAYBE]);
    const setup = await setupRoom();
    await setAutoplay(setup, true);
    const queued = next(setup.socket, 'queue:updated', (q) => q.queue.length > 0);
    setup.socket.emit('queue:add', { url: `https://youtu.be/${KATHANG}` });
    expect(ids((await queued).queue)).toEqual([MAYBE]);
    expect(h.searchCalls).toEqual(['ben&ben maybe the night']);
    const [match] = await h.db.select().from(catalogMatches);
    expect(match).toMatchObject({ catalogId: '202', videoId: MAYBE });
  });

  it('stops searching at the daily autoplay cap', async () => {
    h.songLinks.clear();
    await h.settings.set('search.autoplaySearchesPerDay', 1, null);
    const setup = await setupRoom();
    await setAutoplay(setup, true);
    const started = next(setup.socket, 'playback:state', (s) => s.item?.track.videoId === KATHANG);
    setup.socket.emit('queue:add', { url: `https://youtu.be/${KATHANG}` });
    await started;
    await sleep(100);
    await h.autoplay.fill(setup.roomId);
    // The first search found no match; the second song was refused by the cap.
    expect(h.searchCalls).toEqual(['ben&ben maybe the night']);
    expect((await h.playback.snapshot(setup.roomId)).queue).toEqual([]);
  });

  it("falls back to the host's suggestions when the room's songs give nothing", async () => {
    // The room only played a video the catalog doesn't know, so it has no taste yet.
    h.deezerChart.push('204');
    const setup = await setupRoom();
    await setAutoplay(setup, true);
    const queued = next(setup.socket, 'queue:updated', (q) => q.queue.length > 0);
    setup.socket.emit('queue:add', { url: `https://youtu.be/${OTHER}` });
    expect(ids((await queued).queue)).toEqual([GUSTO]);
    expect(h.searchCalls).toEqual([]);
  });
});
