import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ChatReaction, RoomResponse, SocketError } from '@spotibay/shared';
import { createHarness, joinRoom, next, sleep, type Harness } from './helpers/harness.js';
import { maskFilteredWords } from '../src/lib/word-filter.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.settings.set('features.chat', true, null);
  await h.settings.set('features.reactions', true, null);
  await h.settings.set('limits.chatMessageMaxLength', 300, null);
  await h.settings.set('limits.chatMessagesPerMinute', 20, null);
  await h.settings.set('moderation.wordFilter', [], null);
  await h.redis.flushdb();
});

async function setup() {
  const host = await h.guest();
  const res = await host.api<RoomResponse>('POST', '/rooms', { name: 'Chat room' });
  const code = res.body.room.code;
  const hostSocket = await host.socket();
  await joinRoom(hostSocket, code);
  const friend = await h.guest();
  const friendSocket = await friend.socket();
  const { state } = await joinRoom(friendSocket, code);
  return { host, hostSocket, friend, friendSocket, code, state: state! };
}

const user = (m: ChatMessage) => (m.kind === 'user' ? m : null);
const isUser = (body: string) => (m: ChatMessage) => m.kind === 'user' && m.body === body;

describe('chat', () => {
  it('delivers a message to everyone in the room, with the sender as author', async () => {
    const { host, hostSocket, friendSocket } = await setup();
    const atHost = next(hostSocket, 'chat:message', isUser('hello'));
    const atFriend = next(friendSocket, 'chat:message', isUser('hello'));
    friendSocket.emit('chat:send', { body: '  hello ' });
    const [a, b] = await Promise.all([atHost, atFriend]);
    expect(a).toEqual(b);
    expect(user(a)?.author.displayName).not.toBe(host.user.displayName);
  });

  it('sends the last 50 messages in room:state, oldest first, and persists them', async () => {
    const { host, hostSocket, code } = await setup();
    await h.settings.set('limits.chatMessagesPerMinute', 100, null);
    for (let i = 0; i < 55; i++) {
      const seen = next(hostSocket, 'chat:message', isUser(`m${i}`));
      hostSocket.emit('chat:send', { body: `m${i}` });
      await seen;
    }
    const late = await h.guest();
    const { state } = await joinRoom(await late.socket(), code);
    const bodies = state!.chat.filter((m) => m.kind === 'user').map((m) => m.body);
    expect(bodies).toHaveLength(50);
    expect(bodies[0]).toBe('m5');
    expect(bodies.at(-1)).toBe('m54');
    expect(user(state!.chat[0]!)?.author.userId).toBe(host.user.id);
  });

  it('rejects empty and over-long messages', async () => {
    const { friendSocket } = await setup();
    await h.settings.set('limits.chatMessageMaxLength', 10, null);
    const err = next(friendSocket, 'error');
    friendSocket.emit('chat:send', { body: 'x'.repeat(11) });
    expect((await err).code).toBe('invalid_payload');
    const empty = next(friendSocket, 'error');
    friendSocket.emit('chat:send', { body: '   ' });
    expect((await empty).code).toBe('invalid_payload');
  });

  it('rate limits per user', async () => {
    const { hostSocket, friendSocket } = await setup();
    await h.settings.set('limits.chatMessagesPerMinute', 2, null);
    const errors: SocketError[] = [];
    friendSocket.on('error', (e) => errors.push(e));
    for (let i = 0; i < 3; i++) friendSocket.emit('chat:send', { body: `spam${i}` });
    await next(hostSocket, 'chat:message', isUser('spam1'));
    await sleep(100);
    expect(errors.map((e) => e.code)).toEqual(['rate_limited']);
    // The host has their own budget.
    const ok = next(hostSocket, 'chat:message', isUser('still fine'));
    hostSocket.emit('chat:send', { body: 'still fine' });
    await ok;
  });

  it('masks words from the filter, including leetspeak', async () => {
    const { hostSocket, friendSocket } = await setup();
    await h.settings.set('moderation.wordFilter', ['heck'], null);
    const seen = next(hostSocket, 'chat:message', (m) => m.kind === 'user');
    friendSocket.emit('chat:send', { body: 'what the h3ck is this' });
    expect((await seen).body).toBe('what the **** is this');
  });

  it('is refused while features.chat is off, and room:state carries no history', async () => {
    const { friendSocket, code } = await setup();
    await h.settings.set('features.chat', false, null);
    const err = next(friendSocket, 'error');
    friendSocket.emit('chat:send', { body: 'hi' });
    expect((await err).code).toBe('feature_disabled');
    const late = await h.guest();
    const { state } = await joinRoom(await late.socket(), code);
    expect(state!.chat).toEqual([]);
  });

  it('announces joins, leaves and track changes as system messages', async () => {
    const { host, hostSocket, code } = await setup();
    h.videos.set('video000001', { durationSec: 300, title: 'First Song' });
    const nowPlaying = next(
      hostSocket,
      'chat:message',
      (m) => m.kind === 'system' && m.body === 'Now playing: First Song',
    );
    hostSocket.emit('queue:add', { url: 'https://youtu.be/video000001' });
    await nowPlaying;

    const skipped = next(
      hostSocket,
      'chat:message',
      (m) => m.kind === 'system' && m.body === '"First Song" was skipped',
    );
    hostSocket.emit('playback:skip');
    await skipped;

    const guest = await h.guest();
    const joined = next(
      hostSocket,
      'chat:message',
      (m) => m.kind === 'system' && m.body === `${guest.user.displayName} joined`,
    );
    const guestSocket = await guest.socket();
    await joinRoom(guestSocket, code);
    await joined;
    const left = next(
      hostSocket,
      'chat:message',
      (m) => m.kind === 'system' && m.body === `${guest.user.displayName} left`,
    );
    guestSocket.emit('room:leave');
    await left;
    expect(host.user.id).toBeTruthy();
  });
});

describe('reactions', () => {
  it('broadcasts a reaction to the whole room', async () => {
    const { host, hostSocket, friendSocket } = await setup();
    const atFriend = next(friendSocket, 'chat:reaction');
    const atHost = next(hostSocket, 'chat:reaction');
    hostSocket.emit('chat:react', { emoji: '🔥' });
    const [a, b] = await Promise.all([atFriend, atHost]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ emoji: '🔥', userId: host.user.id });
  });

  it('rejects emojis outside the fixed set', async () => {
    const { hostSocket } = await setup();
    const err = next(hostSocket, 'error');
    (hostSocket as unknown as { emit(e: string, p: unknown): void }).emit('chat:react', {
      emoji: '💩',
    });
    expect((await err).code).toBe('invalid_payload');
  });

  it('drops reactions beyond the rate limit', async () => {
    const { hostSocket, friendSocket } = await setup();
    const got: ChatReaction[] = [];
    friendSocket.on('chat:reaction', (r) => got.push(r));
    for (let i = 0; i < 15; i++) hostSocket.emit('chat:react', { emoji: '👏' });
    await sleep(500);
    expect(got).toHaveLength(10);
  });

  it('is refused while features.reactions is off', async () => {
    const { hostSocket } = await setup();
    await h.settings.set('features.reactions', false, null);
    const err = next(hostSocket, 'error');
    hostSocket.emit('chat:react', { emoji: '🔥' });
    expect((await err).code).toBe('feature_disabled');
  });
});

describe('maskFilteredWords', () => {
  it('masks only the offending words', () => {
    expect(maskFilteredWords('a b4d word, fine', ['bad'])).toBe('a *** word, fine');
  });
  it('leaves text alone with an empty filter', () => {
    expect(maskFilteredWords('anything', [])).toBe('anything');
  });
});
