import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChatMessage,
  ChatReaction,
  ChatSend,
  RoomResponse,
  SocketError,
} from '@spotibay/shared';
import {
  createHarness,
  joinRoom,
  next,
  sleep,
  type ClientSocket,
  type Harness,
} from './helpers/harness.js';
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

describe('chat replies, mentions and media', () => {
  beforeEach(async () => {
    await h.settings.set('features.gifs', true, null);
    h.klipyItems.clear();
    h.klipy.status = null;
    h.klipyItems.set('party-cat-1', { kind: 'gif', title: 'Party cat' });
    h.klipyItems.set('thumbs-up-2', { kind: 'sticker', title: 'Thumbs up' });
    h.klipyItems.set('elsewhere-3', { kind: 'gif', title: 'Elsewhere', host: 'evil.example' });
  });

  async function say(socket: ClientSocket, payload: ChatSend, from: ClientSocket = socket) {
    const seen = next(from, 'chat:message', (m) => m.kind === 'user' && m.body === payload.body);
    socket.emit('chat:send', payload);
    return user(await seen)!;
  }

  it('replies quote the original, and history keeps the quote', async () => {
    const { hostSocket, friendSocket, code, host } = await setup();
    const original = await say(hostSocket, { body: 'who wants lofi?' });
    const reply = await say(friendSocket, { body: 'me!', replyToId: original.id }, hostSocket);
    expect(reply.replyTo).toEqual({
      id: original.id,
      authorName: host.user.displayName,
      excerpt: 'who wants lofi?',
      media: null,
      deleted: false,
    });
    const { state } = await joinRoom(await (await h.guest()).socket(), code);
    const stored = state!.chat.map(user).find((m) => m?.id === reply.id);
    expect(stored?.replyTo?.id).toBe(original.id);
  });

  it('shows a removed original as deleted and refuses new replies to it', async () => {
    const { hostSocket, friendSocket, code } = await setup();
    const original = await say(hostSocket, { body: 'oops' });
    const reply = await say(friendSocket, { body: 'lol', replyToId: original.id }, hostSocket);
    await h.db.execute(`update chat_messages set deleted_at = now() where id = '${original.id}'`);
    const { state } = await joinRoom(await (await h.guest()).socket(), code);
    expect(state!.chat.map(user).find((m) => m?.id === reply.id)?.replyTo).toMatchObject({
      deleted: true,
      excerpt: '',
    });
    const err = next(friendSocket, 'error');
    friendSocket.emit('chat:send', { body: 'again', replyToId: original.id });
    expect((await err).code).toBe('invalid_payload');
  });

  it('refuses replies to a message from another room', async () => {
    const { hostSocket } = await setup();
    const other = await setup();
    const elsewhere = await say(other.hostSocket, { body: 'other room' });
    const err = next(hostSocket, 'error');
    hostSocket.emit('chat:send', { body: 'sneaky', replyToId: elsewhere.id });
    expect((await err).code).toBe('invalid_payload');
  });

  it('keeps only mentions of people in the room whose name is in the text', async () => {
    const { hostSocket, friendSocket, friend, host } = await setup();
    const outsider = await h.guest();
    const msg = await say(
      hostSocket,
      {
        body: `hey @${friend.user.displayName} and @${outsider.user.displayName}`,
        mentionIds: [friend.user.id, outsider.user.id, host.user.id],
      },
      friendSocket,
    );
    expect(msg.mentions).toEqual([
      { userId: friend.user.id, displayName: friend.user.displayName },
    ]);
  });

  it('sends GIFs and stickers with the server copy of the media', async () => {
    const { hostSocket, friendSocket } = await setup();
    const gif = await say(
      friendSocket,
      { body: '', media: { kind: 'gif', id: 'party-cat-1' } },
      hostSocket,
    );
    expect(gif.media).toEqual({
      kind: 'gif',
      id: 'party-cat-1',
      title: 'Party cat',
      url: 'https://static.klipy.com/party-cat-1/md.webp',
      previewUrl: 'https://static.klipy.com/party-cat-1/sm.webp',
      width: 220,
      height: 160,
    });
    const sticker = await say(
      friendSocket,
      { body: 'nice', media: { kind: 'sticker', id: 'thumbs-up-2' } },
      hostSocket,
    );
    expect(sticker.media?.kind).toBe('sticker');
    const reply = await say(hostSocket, { body: 'ha', replyToId: gif.id });
    expect(reply.replyTo).toMatchObject({ excerpt: '', media: 'gif' });
  });

  it('refuses unknown media, media from other hosts and media while GIFs are off', async () => {
    const { friendSocket } = await setup();
    for (const id of ['nope-0', 'elsewhere-3']) {
      const err = next(friendSocket, 'error');
      friendSocket.emit('chat:send', { body: '', media: { kind: 'gif', id } });
      expect((await err).code).toBe('invalid_payload');
    }
    const wrongKind = next(friendSocket, 'error');
    friendSocket.emit('chat:send', { body: '', media: { kind: 'sticker', id: 'party-cat-1' } });
    expect((await wrongKind).code).toBe('invalid_payload');
    const badId = next(friendSocket, 'error');
    friendSocket.emit('chat:send', {
      body: '',
      media: { kind: 'gif', id: '../https://evil.example/x.gif' },
    });
    expect((await badId).code).toBe('invalid_payload');
    await h.settings.set('features.gifs', false, null);
    const off = next(friendSocket, 'error');
    friendSocket.emit('chat:send', { body: '', media: { kind: 'gif', id: 'party-cat-1' } });
    expect((await off).code).toBe('feature_disabled');
  });
});

describe('message reactions', () => {
  it('toggles an emoji on a message for everyone, and history keeps it', async () => {
    const { hostSocket, friendSocket, host, friend, code } = await setup();
    const seen = next(hostSocket, 'chat:message', isUser('drop incoming'));
    hostSocket.emit('chat:send', { body: 'drop incoming' });
    const message = user(await seen)!;
    expect(message.reactions).toEqual([]);

    const first = next(hostSocket, 'chat:messageReactions');
    friendSocket.emit('chat:reactMessage', { messageId: message.id, emoji: '🔥' });
    expect(await first).toEqual({
      messageId: message.id,
      reactions: [{ emoji: '🔥', userIds: [friend.user.id] }],
    });
    const count = (n: number) => (p: { reactions: { userIds: string[] }[] }) =>
      (p.reactions[0]?.userIds.length ?? 0) === n;
    const second = next(friendSocket, 'chat:messageReactions', count(2));
    hostSocket.emit('chat:reactMessage', { messageId: message.id, emoji: '🔥' });
    expect((await second).reactions).toEqual([
      { emoji: '🔥', userIds: [friend.user.id, host.user.id] },
    ]);

    const { state } = await joinRoom(await (await h.guest()).socket(), code);
    expect(state!.chat.map(user).find((m) => m?.id === message.id)?.reactions).toEqual([
      { emoji: '🔥', userIds: [friend.user.id, host.user.id] },
    ]);

    const undone = next(hostSocket, 'chat:messageReactions', count(1));
    friendSocket.emit('chat:reactMessage', { messageId: message.id, emoji: '🔥' });
    expect((await undone).reactions).toEqual([{ emoji: '🔥', userIds: [host.user.id] }]);
  });

  it('refuses unknown emojis, other rooms and removed messages', async () => {
    const { hostSocket, friendSocket } = await setup();
    const other = await setup();
    const seen = next(other.hostSocket, 'chat:message', isUser('elsewhere'));
    other.hostSocket.emit('chat:send', { body: 'elsewhere' });
    const elsewhere = user(await seen)!;

    const badEmoji = next(friendSocket, 'error');
    friendSocket.emit('chat:reactMessage', { messageId: elsewhere.id, emoji: '💩' } as never);
    expect((await badEmoji).code).toBe('invalid_payload');
    const crossRoom = next(friendSocket, 'error');
    friendSocket.emit('chat:reactMessage', { messageId: elsewhere.id, emoji: '👍' });
    expect((await crossRoom).code).toBe('invalid_payload');

    const mine = next(hostSocket, 'chat:message', isUser('oops'));
    hostSocket.emit('chat:send', { body: 'oops' });
    const removed = user(await mine)!;
    await h.db.execute(`update chat_messages set deleted_at = now() where id = '${removed.id}'`);
    const gone = next(friendSocket, 'error');
    friendSocket.emit('chat:reactMessage', { messageId: removed.id, emoji: '👍' });
    expect((await gone).code).toBe('invalid_payload');
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
