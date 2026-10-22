import { avatarStyles, type Avatar } from '@spotibay/shared';
import { describe, expect, it } from 'vitest';
import { avatarDataUri, avatarStyleLabels, randomSeed } from '../src/lib/avatar';

describe('avatarDataUri', () => {
  const base: Avatar = { style: 'bottts', seed: 'abc123', options: { backgroundColor: 'ceff00' } };

  it('renders every style to an SVG data URI', () => {
    for (const style of avatarStyles) {
      expect(avatarDataUri({ ...base, style })).toMatch(/^data:image\/svg\+xml/);
      expect(avatarStyleLabels[style]).toBeTruthy();
    }
  });

  it('is deterministic and responds to seed and background', () => {
    expect(avatarDataUri(base)).toBe(avatarDataUri({ ...base }));
    expect(avatarDataUri({ ...base, seed: 'other' })).not.toBe(avatarDataUri(base));
    expect(avatarDataUri({ ...base, options: { backgroundColor: 'ffd5dc' } })).not.toBe(
      avatarDataUri(base),
    );
  });

  it('generates 12-char hex seeds', () => {
    expect(randomSeed()).toMatch(/^[0-9a-f]{12}$/);
  });
});
