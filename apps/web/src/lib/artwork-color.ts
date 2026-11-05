/** An accent colour taken from album art, and the ink that reads on it. */
export interface Accent {
  /** `rgb(r g b)`. */
  color: string;
  /** Black or white, whichever reads better on `color`. */
  ink: string;
}

/** Below this chroma a pixel is near gray (white walls, black bars) and says nothing about the art. */
const MIN_SATURATION = 0.2;

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function fromHsl(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255)) as [number, number, number];
}

/** WCAG relative luminance of an sRGB colour. */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * The accent of an image from its pixels (RGBA, as a canvas gives them): the most common hue
 * among colourful pixels, weighted by how colourful they are, lifted to a vivid, mid-light
 * tone so it works as a button on both themes. `null` when the image is all grays.
 */
export function accentFromPixels(data: ArrayLike<number>): Accent | null {
  // 12 hue buckets of 30°; each keeps a weighted sum of the pixels that fall in it.
  const buckets = Array.from({ length: 12 }, () => ({ weight: 0, h: 0, s: 0 }));
  for (let i = 0; i + 3 < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < 128) continue;
    const [h, s, l] = toHsl(data[i]!, data[i + 1]!, data[i + 2]!);
    if (s < MIN_SATURATION || l < 0.12 || l > 0.92) continue;
    const bucket = buckets[Math.floor(h / 30) % 12]!;
    bucket.weight += s;
    bucket.h += h * s;
    bucket.s += s * s;
  }
  const best = buckets.reduce((a, b) => (b.weight > a.weight ? b : a));
  if (best.weight === 0) return null;
  const hue = best.h / best.weight;
  const sat = Math.min(0.9, Math.max(0.55, best.s / best.weight));
  const rgb = fromHsl(hue, sat, 0.58);
  // Contrast with black is (L + 0.05) / 0.05, with white 1.05 / (L + 0.05); take the larger.
  const lum = luminance(rgb);
  const ink = (lum + 0.05) / 0.05 >= 1.05 / (lum + 0.05) ? '#000000' : '#ffffff';
  return { color: `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`, ink };
}
