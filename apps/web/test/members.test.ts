import { describe, expect, it } from 'vitest';
import type { Member } from '@spotibay/shared';
import { diffMembers } from '../src/lib/members';

const member = (userId: string): Member => ({
  userId,
  displayName: userId,
  avatar: { style: 'thumbs', seed: userId, options: {} },
  role: 'listener',
  joinedAt: 0,
});

describe('diffMembers', () => {
  it('reports arrivals and departures', () => {
    const { joined, left } = diffMembers(
      [member('a'), member('b')],
      [member('b'), member('c')],
      'z',
    );
    expect(joined.map((m) => m.userId)).toEqual(['c']);
    expect(left.map((m) => m.userId)).toEqual(['a']);
  });

  it('never reports the viewer themselves', () => {
    const { joined, left } = diffMembers([member('me')], [member('x')], 'me');
    expect(joined.map((m) => m.userId)).toEqual(['x']);
    expect(left).toEqual([]);
  });

  it('is empty when nothing changed', () => {
    expect(diffMembers([member('a')], [member('a')], 'z')).toEqual({ joined: [], left: [] });
  });
});
