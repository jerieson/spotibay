/** Pictures over this size aren't uploaded at all (the server refuses them too). */
export const MAX_PICK_BYTES = 8 * 1024 * 1024;

/**
 * The picture made smaller before upload, to save data on phones: at most `maxSide` px a side,
 * as WebP, turned upright. GIFs are left as they are so they stay animated; the original is
 * kept when shrinking doesn't help or the browser can't decode it. The server re-encodes anyway.
 */
export async function shrinkImage(file: Blob, maxSide = 1600): Promise<Blob> {
  if (file.type === 'image/gif' || typeof createImageBitmap === 'undefined') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.85),
  );
  return blob && blob.size < file.size ? blob : file;
}
