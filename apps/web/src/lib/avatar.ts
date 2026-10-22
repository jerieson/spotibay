import { createAvatar } from '@dicebear/core';
import {
  adventurer,
  avataaars,
  bigSmile,
  bottts,
  funEmoji,
  lorelei,
  notionists,
  thumbs,
} from '@dicebear/collection';
import type { Avatar, AvatarStyle } from '@spotibay/shared';

interface RenderOptions {
  seed: string;
  backgroundColor?: string[];
}

// One closure per style: DiceBear's option types differ per style, so a union lookup won't typecheck.
const renderers: Record<AvatarStyle, (options: RenderOptions) => string> = {
  adventurer: (o) => createAvatar(adventurer, o).toDataUri(),
  avataaars: (o) => createAvatar(avataaars, o).toDataUri(),
  bigSmile: (o) => createAvatar(bigSmile, o).toDataUri(),
  bottts: (o) => createAvatar(bottts, o).toDataUri(),
  funEmoji: (o) => createAvatar(funEmoji, o).toDataUri(),
  lorelei: (o) => createAvatar(lorelei, o).toDataUri(),
  notionists: (o) => createAvatar(notionists, o).toDataUri(),
  thumbs: (o) => createAvatar(thumbs, o).toDataUri(),
};

export const avatarStyleLabels: Record<AvatarStyle, string> = {
  adventurer: 'Adventurer',
  avataaars: 'Avataaars',
  bigSmile: 'Big smile',
  bottts: 'Bottts',
  funEmoji: 'Fun emoji',
  lorelei: 'Lorelei',
  notionists: 'Notionists',
  thumbs: 'Thumbs',
};

const cache = new Map<string, string>();

export function avatarDataUri(avatar: Avatar): string {
  const key = JSON.stringify(avatar);
  let uri = cache.get(key);
  if (!uri) {
    uri = renderers[avatar.style]({
      seed: avatar.seed,
      ...(avatar.options.backgroundColor
        ? { backgroundColor: [avatar.options.backgroundColor] }
        : {}),
    });
    if (cache.size > 200) cache.clear();
    cache.set(key, uri);
  }
  return uri;
}

export function randomSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
