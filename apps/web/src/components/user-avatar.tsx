import type { Avatar } from '@spotibay/shared';
import { avatarDataUri } from '@/lib/avatar';
import { cn } from '@/lib/utils';

export function UserAvatar({
  avatar,
  name,
  className,
}: {
  avatar: Avatar;
  name: string;
  className?: string;
}) {
  return (
    <img
      src={avatarDataUri(avatar)}
      alt={name}
      className={cn('size-9 shrink-0 rounded-full bg-muted object-cover', className)}
    />
  );
}
