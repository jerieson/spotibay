import sharp from 'sharp';

// One image at a time and no cache: the api container has little memory to spare.
sharp.concurrency(1);
sharp.cache(false);

/** Larger uploads are refused before they are read. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** Decoding stops above this many pixels (a "decompression bomb" guard). */
const MAX_INPUT_PIXELS = 40_000_000;
/** Animated images keep at most this many frames. */
const MAX_FRAMES = 50;
const CHAT_MAX_SIDE = 1600;
const CHAT_MAX_STORED_BYTES = 1.5 * 1024 * 1024;
const AVATAR_SIDE = 256;
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif']);

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

/** What a picture is, or an `ImageError` when the bytes aren't one we take. */
async function inspect(input: Buffer) {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new ImageError("That file isn't a picture we can use");
  }
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
    throw new ImageError('Use a JPEG, PNG, WebP, GIF or AVIF picture');
  }
  return { animated: (meta.pages ?? 1) > 1 };
}

/**
 * A chat photo, re-encoded as WebP: turned upright, at most 1600 px a side, every bit of
 * metadata (camera, GPS) dropped. Animated GIFs stay animated.
 */
export async function chatPhoto(
  input: Buffer,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  const { animated } = await inspect(input);
  for (const quality of [80, 60]) {
    let image = sharp(input, {
      animated,
      pages: animated ? MAX_FRAMES : 1,
      limitInputPixels: MAX_INPUT_PIXELS,
    });
    if (!animated) image = image.autoOrient();
    const { data, info } = await image
      .resize({
        width: CHAT_MAX_SIDE,
        height: CHAT_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality, effort: 4 })
      .toBuffer({ resolveWithObject: true })
      .catch(() => {
        throw new ImageError("That picture couldn't be read");
      });
    if (data.length <= CHAT_MAX_STORED_BYTES) {
      return { bytes: data, width: info.width, height: info.pageHeight ?? info.height };
    }
  }
  throw new ImageError('That picture is too big. Try a smaller one.');
}

/** An avatar: the middle of the picture as a 256 px square WebP, still images only. */
export async function avatarPhoto(input: Buffer): Promise<Buffer> {
  await inspect(input);
  return sharp(input, { pages: 1, limitInputPixels: MAX_INPUT_PIXELS })
    .autoOrient()
    .resize({ width: AVATAR_SIDE, height: AVATAR_SIDE, fit: 'cover', position: 'attention' })
    .webp({ quality: 82 })
    .toBuffer()
    .catch(() => {
      throw new ImageError("That picture couldn't be read");
    });
}
