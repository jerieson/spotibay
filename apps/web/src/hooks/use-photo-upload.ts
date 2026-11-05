import { useEffect, useRef, useState } from 'react';
import { chatPhotoUploadResponseSchema } from '@spotibay/shared';
import { MAX_PICK_BYTES, shrinkImage } from '@/lib/shrink-image';

export type PhotoUpload =
  | { status: 'uploading'; previewUrl: string; progress: number }
  | { status: 'ready'; previewUrl: string; id: string }
  | { status: 'failed'; previewUrl: string; message: string };

/** Why the server refused, from its JSON error; a plain message otherwise. */
function errorMessage(xhr: XMLHttpRequest): string {
  try {
    const body = JSON.parse(xhr.responseText) as { message?: string };
    if (body.message) return body.message;
  } catch {
    // Not JSON.
  }
  return xhr.status === 413 ? 'That photo is too big' : "That photo couldn't be uploaded";
}

/**
 * One photo for the chat box: pick (or paste, or drop) a picture and it uploads right away,
 * with progress; `clear` cancels it. The id goes with the message when it's sent.
 */
export function usePhotoUpload(roomCode: string | undefined) {
  const [upload, setUpload] = useState<PhotoUpload | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const urlRef = useRef<string | null>(null);

  function clear() {
    xhrRef.current?.abort();
    xhrRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setUpload(null);
  }

  useEffect(() => clear, []);

  async function pick(file: File) {
    clear();
    if (!roomCode) return;
    const previewUrl = URL.createObjectURL(file);
    urlRef.current = previewUrl;
    if (!file.type.startsWith('image/')) {
      setUpload({ status: 'failed', previewUrl, message: 'Pick a picture' });
      return;
    }
    if (file.size > MAX_PICK_BYTES) {
      setUpload({ status: 'failed', previewUrl, message: 'That photo is too big (8 MB at most)' });
      return;
    }
    setUpload({ status: 'uploading', previewUrl, progress: 0 });
    const body = await shrinkImage(file);
    if (urlRef.current !== previewUrl) return; // Cleared while shrinking.
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open('POST', `/api/rooms/${roomCode}/photos`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', body.type || file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setUpload({ status: 'uploading', previewUrl, progress: e.loaded / e.total });
      }
    };
    xhr.onload = () => {
      xhrRef.current = null;
      const parsed =
        xhr.status === 201
          ? chatPhotoUploadResponseSchema.safeParse(JSON.parse(xhr.responseText))
          : null;
      setUpload(
        parsed?.success
          ? { status: 'ready', previewUrl, id: parsed.data.id }
          : { status: 'failed', previewUrl, message: errorMessage(xhr) },
      );
    };
    xhr.onerror = () => {
      xhrRef.current = null;
      setUpload({ status: 'failed', previewUrl, message: 'Upload failed. Check your connection.' });
    };
    xhr.send(body);
  }

  return { upload, pick, clear };
}
