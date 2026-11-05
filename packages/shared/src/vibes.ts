import { z } from 'zod';
import { suggestResponseSchema } from './search.js';

/** Moods and genres to start from on the home page. */
export const vibeIdSchema = z.enum([
  'work-mode',
  'chillero',
  'ultimate-relapse',
  'trending',
  'throwback',
  'focus',
]);
export type VibeId = z.infer<typeof vibeIdSchema>;

export interface Vibe {
  id: VibeId;
  name: string;
  tagline: string;
}

export const VIBES: readonly Vibe[] = [
  { id: 'work-mode', name: 'Work Mode', tagline: 'Energize and get it done' },
  { id: 'chillero', name: 'Chillero', tagline: 'Chill songs and soul' },
  { id: 'ultimate-relapse', name: 'Ultimate Relapse', tagline: 'Sad songs, for when it hits' },
  { id: 'trending', name: 'Trending', tagline: 'What everyone is playing now' },
  { id: 'throwback', name: 'Throwback', tagline: "Hits from the '80s to the 2000s" },
  { id: 'focus', name: 'Focus', tagline: 'Lofi and piano to study to' },
];

/** `GET /api/vibes/:id`: songs for a vibe. Song info from Deezer; no video until resolved. */
export const vibeResponseSchema = suggestResponseSchema;
export type VibeResponse = z.infer<typeof vibeResponseSchema>;
