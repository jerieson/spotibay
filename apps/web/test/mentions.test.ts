import { describe, expect, it } from 'vitest';
import {
  activeMentionIds,
  findMentionQuery,
  insertMention,
  splitMentions,
} from '../src/lib/mentions';

describe('findMentionQuery', () => {
  it('finds the @name being typed before the caret', () => {
    expect(findMentionQuery('hi @Sa', 6)).toEqual({ start: 3, query: 'Sa' });
    expect(findMentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(findMentionQuery('hey @Sam Lee', 12)).toEqual({ start: 4, query: 'Sam Lee' });
  });

  it('ignores @ inside words, after the caret, and long runs', () => {
    expect(findMentionQuery('me@mail.com', 11)).toBeNull();
    expect(findMentionQuery('hi @Sam', 2)).toBeNull();
    expect(findMentionQuery(`@${'x'.repeat(25)}`, 26)).toBeNull();
    expect(findMentionQuery('no mention', 10)).toBeNull();
  });
});

describe('insertMention', () => {
  it('replaces the partial name and puts the caret after it', () => {
    expect(insertMention('hi @Sa there', 3, 6, 'Sam Lee')).toEqual({
      text: 'hi @Sam Lee  there',
      caret: 12,
    });
  });
});

describe('activeMentionIds', () => {
  it('keeps only picks still written in the draft', () => {
    const picked = new Map([
      ['a', 'Sam'],
      ['b', 'Alex'],
    ]);
    expect(activeMentionIds('hi @Sam', picked)).toEqual(['a']);
    expect(activeMentionIds('hi everyone', picked)).toEqual([]);
  });
});

describe('splitMentions', () => {
  it('returns plain text when nobody is mentioned', () => {
    expect(splitMentions('hello @nobody', [])).toEqual([{ type: 'text', text: 'hello @nobody' }]);
    expect(splitMentions('', [])).toEqual([]);
  });

  it('marks confirmed mentions, preferring the longest name', () => {
    const mentions = [
      { userId: 'a', displayName: 'Sam' },
      { userId: 'b', displayName: 'Sam Lee' },
    ];
    expect(splitMentions('@Sam Lee and @Sam!', mentions)).toEqual([
      { type: 'mention', text: '@Sam Lee', userId: 'b' },
      { type: 'text', text: ' and ' },
      { type: 'mention', text: '@Sam', userId: 'a' },
      { type: 'text', text: '!' },
    ]);
  });
});
