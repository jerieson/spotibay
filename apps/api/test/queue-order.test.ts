import { describe, expect, it } from 'vitest';
import { moveItem, orderQueue, skipVotesNeeded, type OrderableItem } from '@spotibay/shared';

let counter = 0;
/** Items get increasing positions in the order they are listed, like successive adds. */
function items(...specs: [user: string, score?: number][]): OrderableItem[] {
  return specs.map(([addedBy, score = 0]) => {
    counter += 1;
    return { id: `${addedBy}${counter}`, addedBy, position: counter, score };
  });
}
const users = (list: OrderableItem[]) => list.map((i) => i.addedBy).join('');

describe('orderQueue fifo', () => {
  it('keeps add order without votes', () => {
    const q = items(['a'], ['b'], ['a'], ['c']);
    expect(orderQueue(q, 'fifo').map((i) => i.id)).toEqual(q.map((i) => i.id));
  });

  it('puts the higher score first and breaks ties by position', () => {
    const [first, second, third, fourth] = items(['a', 0], ['b', 2], ['c', 2], ['d', -1]);
    expect(orderQueue([first!, second!, third!, fourth!], 'fifo')).toEqual([
      second,
      third,
      first,
      fourth,
    ]);
  });

  it('does not mutate its input', () => {
    const q = items(['a', 0], ['b', 5]);
    const copy = [...q];
    orderQueue(q, 'fifo');
    expect(q).toEqual(copy);
  });
});

describe('orderQueue fair', () => {
  it('interleaves users in the order of their first item', () => {
    // a queues three tracks before b and c show up with one each.
    expect(users(orderQueue(items(['a'], ['a'], ['a'], ['b'], ['c']), 'fair'))).toBe('abcaa');
  });

  it('lets a user with more items keep going once the others run out', () => {
    expect(users(orderQueue(items(['a'], ['b'], ['b'], ['b'], ['a']), 'fair'))).toBe('ababb');
  });

  it('ignores scores', () => {
    const q = items(['a', -5], ['a', 9], ['b', 0]);
    expect(orderQueue(q, 'fair').map((i) => i.id)).toEqual([q[0]!.id, q[2]!.id, q[1]!.id]);
  });

  it("keeps a user's own items in position order", () => {
    const [a1, a2, b1] = items(['a'], ['a'], ['b']);
    a1!.position = 10;
    a2!.position = 5;
    expect(orderQueue([a1!, a2!, b1!], 'fair')).toEqual([a2, b1, a1]);
  });

  it('puts the user who is playing now at the back of the rotation', () => {
    const q = items(['a'], ['a'], ['b'], ['c']);
    expect(users(orderQueue(q, 'fair', { playingBy: 'a' }))).toBe('bcaa');
    expect(users(orderQueue(q, 'fair', { playingBy: 'b' }))).toBe('acba');
    expect(users(orderQueue(q, 'fair', { playingBy: 'zed' }))).toBe('abca');
  });

  it('does not reorder a single user', () => {
    const q = items(['a'], ['a']);
    expect(orderQueue(q, 'fair', { playingBy: 'a' }).map((i) => i.id)).toEqual(q.map((i) => i.id));
  });

  it('handles an empty queue', () => {
    expect(orderQueue([], 'fair')).toEqual([]);
    expect(orderQueue([], 'fifo')).toEqual([]);
  });
});

describe('moveItem', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('moves forward and backward', () => {
    expect(moveItem(list, 'a', 2).map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(moveItem(list, 'c', 0).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });
  it('clamps the index and ignores unknown ids', () => {
    expect(moveItem(list, 'a', 99).map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(moveItem(list, 'zzz', 0)).toEqual(list);
  });
});

describe('skipVotesNeeded', () => {
  it.each([
    [1, 0.5, 1],
    [2, 0.5, 1],
    [3, 0.5, 2],
    [4, 0.5, 2],
    [5, 0.5, 3],
    [10, 0.51, 6],
    [0, 0.5, 1],
    [3, 1, 3],
  ])('%i members at %f needs %i votes', (members, threshold, expected) => {
    expect(skipVotesNeeded(members, threshold)).toBe(expected);
  });
});
