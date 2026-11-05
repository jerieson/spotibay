import { useEffect, useState } from 'react';
import { accentFromPixels, type Accent } from '@/lib/artwork-color';

const SIZE = 24;
const cache = new Map<string, Accent | null>();

/** Reads the image small on a canvas; `null` when it can't be read (no CORS) or is all grays. */
function readAccent(url: string): Promise<Accent | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        resolve(accentFromPixels(ctx.getImageData(0, 0, SIZE, SIZE).data));
      } catch {
        // A tainted canvas (the host sent no CORS header): no accent.
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** The accent colour of the artwork at `url`, once read; `null` until then or when there is none. */
export function useArtworkColor(url: string | null | undefined): Accent | null {
  const [accent, setAccent] = useState<Accent | null>(() =>
    url ? (cache.get(url) ?? null) : null,
  );
  useEffect(() => {
    if (!url) {
      setAccent(null);
      return;
    }
    if (cache.has(url)) {
      setAccent(cache.get(url) ?? null);
      return;
    }
    let live = true;
    void readAccent(url).then((found) => {
      cache.set(url, found);
      if (live) setAccent(found);
    });
    return () => {
      live = false;
    };
  }, [url]);
  return accent;
}
