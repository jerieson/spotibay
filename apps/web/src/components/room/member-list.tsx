import { Crown, Disc3, UserMinus } from 'lucide-react';
import type { Member, RoomRole } from '@spotibay/shared';
import { UserAvatar } from '@/components/user-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { roleLabels } from '@/lib/members';
import { socket } from '@/lib/socket';

export function MemberList({
  members,
  selfId,
  viewerRole,
}: {
  members: Member[];
  selfId: string;
  viewerRole: RoomRole;
}) {
  const isHost = viewerRole === 'host';
  return (
    <ul className="divide-y rounded-2xl border bg-card" aria-label="Members">
      {members.map((m) => (
        <li key={m.userId} className="flex items-center gap-3 p-3" data-testid="member">
          <UserAvatar avatar={m.avatar} name={m.displayName} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {m.displayName}
              {m.userId === selfId && <span className="text-muted-foreground"> (you)</span>}
            </p>
          </div>
          {m.role !== 'listener' && (
            <Badge variant={m.role === 'host' ? 'host' : 'dj'}>{roleLabels[m.role]}</Badge>
          )}
          {isHost && m.userId !== selfId && (
            <div className="flex gap-1">
              <Button
                size="icon"
                variant="ghost"
                aria-label={
                  m.role === 'dj' ? `Remove DJ from ${m.displayName}` : `Make ${m.displayName} a DJ`
                }
                title={m.role === 'dj' ? 'Remove DJ' : 'Make DJ'}
                onClick={() =>
                  socket.emit('room:setRole', {
                    userId: m.userId,
                    role: m.role === 'dj' ? 'listener' : 'dj',
                  })
                }
              >
                {m.role === 'dj' ? <UserMinus /> : <Disc3 />}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Make ${m.displayName} the host`}
                title="Make host"
                onClick={() => socket.emit('room:transferHost', { userId: m.userId })}
              >
                <Crown />
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
