import { VIDEO_ID_PATTERN } from './playback.js';

export const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);

/**
 * Extracts the 11-character video id from a YouTube link or a bare id; `null` if there is none.
 * Shared so the web app can spot a pasted link; the server still checks the video itself.
 */
export function parseVideoId(input: string): string | null {
  const text = input.trim();
  if (VIDEO_ID_PATTERN.test(text)) return text;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  let candidate: string | null | undefined;
  if (host === 'youtu.be') {
    candidate = segments[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (segments[0] === 'watch') candidate = url.searchParams.get('v');
    else if (segments[0] === 'shorts') candidate = segments[1];
  }
  return candidate && VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}
