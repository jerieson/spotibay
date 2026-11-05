import { useState } from 'react';
import type { Avatar } from '@spotibay/shared';
import { avatarDataUri } from '@/lib/avatar';
import { cn } from '@/lib/utils';

/** The person's photo when they set one, else their generated avatar (also if the photo fails). */
export function UserAvatar({
  avatar,
  name,
  className,
  photoBase = '/api/avatars',
}: {
  avatar: Avatar;
  name: string;
  className?: string;
  /** Where photos are fetched from; the admin panel uses its own route. */
  photoBase?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const photo = avatar.photoId && failed !== avatar.photoId ? avatar.photoId : null;
  return (
    <img
      src={photo ? `${photoBase}/${photo}` : avatarDataUri(avatar)}
      alt={name}
      loading={photo ? 'lazy' : undefined}
      onError={photo ? () => setFailed(photo) : undefined}
      className={cn('size-9 shrink-0 rounded-full bg-muted object-cover', className)}
    />
  );
}
