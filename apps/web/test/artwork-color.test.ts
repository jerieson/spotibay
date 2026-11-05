import { describe, expect, it } from 'vitest';
import { accentFromPixels } from '../src/lib/artwork-color';

/** RGBA pixels: `count` copies of each colour. */
function pixels(...runs: [number, number, number, number][]): number[] {
  return runs.flatMap(([r, g, b, count]) =>
    Array.from({ length: count }, () => [r, g, b, 255]).flat(),
  );
}

const rgb = (color: string) => color.match(/\d+/g)!.map(Number);

describe('accentFromPixels', () => {
  it('takes the most common colourful hue, ignoring grays', () => {
    // Mostly black and white, with a patch of purple and a little green.
    const accent = accentFromPixels(
      pixels([0, 0, 0, 200], [255, 255, 255, 200], [120, 40, 200, 60], [30, 160, 60, 10]),
    )!;
    const [r, g, b] = rgb(accent.color);
    expect(b).toBeGreaterThan(g!);
    expect(r).toBeGreaterThan(g!);
  });

  it('gives nothing for an all-gray image', () => {
    expect(accentFromPixels(pixels([20, 20, 20, 100], [200, 200, 200, 100]))).toBeNull();
  });

  it('picks ink that reads on the accent', () => {
    expect(accentFromPixels(pixels([250, 220, 40, 50]))!.ink).toBe('#000000');
    expect(accentFromPixels(pixels([40, 30, 160, 50]))!.ink).toBe('#ffffff');
  });
});
