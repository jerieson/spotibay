import { DISPLAY_NAME_MAX, type ChatMention } from '@spotibay/shared';

/** The `@name` being typed just before the caret: where its `@` is and the text after it. */
export function findMentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('@');
  if (start === -1) return null;
  // Only at the start of a word, so emails and the like don't open the picker.
  if (start > 0 && !/\s/.test(before[start - 1]!)) return null;
  const query = before.slice(start + 1);
  // Names may contain spaces, but not line breaks, and are never longer than this.
  if (query.length > DISPLAY_NAME_MAX || /[\n\r]/.test(query)) return null;
  return { start, query };
}

/** Replaces the `@query` from `start` to `caret` with the full `@name `. */
export function insertMention(text: string, start: number, caret: number, name: string) {
  const inserted = `@${name} `;
  return {
    text: text.slice(0, start) + inserted + text.slice(caret),
    caret: start + inserted.length,
  };
}

/** Ids of picked people whose `@name` is still in the draft. */
export function activeMentionIds(draft: string, picked: ReadonlyMap<string, string>): string[] {
  return [...picked].filter(([, name]) => draft.includes(`@${name}`)).map(([id]) => id);
}

export type MessageSegment =
  { type: 'text'; text: string } | { type: 'mention'; text: string; userId: string };

/** Splits a message into plain text and the mentions the server confirmed. */
export function splitMentions(body: string, mentions: readonly ChatMention[]): MessageSegment[] {
  if (mentions.length === 0) return body === '' ? [] : [{ type: 'text', text: body }];
  // Longest first, so "@Sam Lee" wins over "@Sam".
  const names = [...mentions].sort((a, b) => b.displayName.length - a.displayName.length);
  const segments: MessageSegment[] = [];
  let text = '';
  let i = 0;
  while (i < body.length) {
    const hit =
      body[i] === '@' ? names.find((m) => body.startsWith(`@${m.displayName}`, i)) : undefined;
    if (hit) {
      if (text) segments.push({ type: 'text', text });
      text = '';
      const mention = `@${hit.displayName}`;
      segments.push({ type: 'mention', text: mention, userId: hit.userId });
      i += mention.length;
    } else {
      text += body[i];
      i += 1;
    }
  }
  if (text) segments.push({ type: 'text', text });
  return segments;
}
