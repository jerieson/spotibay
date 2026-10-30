import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { MAX_BAN_MINUTES, type AdminBan, type CreateBanBody } from '@spotibay/shared';
import { UserAvatar } from '@/components/user-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { adminApi } from './admin-api';
import { Card, Empty, formatTime, PageHeader, QueryState } from './ui';
import { friendlyError } from '@/lib/errors';

const durations = [
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 60 * 24 },
  { label: '7 days', minutes: 60 * 24 * 7 },
  { label: '30 days', minutes: 60 * 24 * 30 },
  { label: 'Permanent', minutes: null },
] as const;

export function UsersPage() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const users = useQuery({ queryKey: ['admin', 'users', q], queryFn: () => adminApi.users(q) });

  return (
    <>
      <PageHeader title="Users & Bans" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <form
            className="flex gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setQ(search.trim());
            }}
          >
            <Input
              placeholder="Search by display name"
              aria-label="Search users"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button type="submit">Search</Button>
          </form>
          <QueryState isPending={users.isPending} error={users.error} />
          {users.data?.length === 0 && <Empty>No users found.</Empty>}
          <ul className="space-y-1.5">
            {users.data?.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => setSelected(u.id)}
                  aria-pressed={selected === u.id}
                  className="flex w-full items-center gap-3 rounded-xl border bg-card p-3 text-left hover:border-ring/60 aria-pressed:border-ring"
                >
                  <UserAvatar avatar={u.avatar} name={u.displayName} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{u.displayName}</span>
                    <span className="text-sm text-muted-foreground">
                      Last seen {formatTime(u.lastSeenAt)}
                    </span>
                  </span>
                  {u.banned && <Badge variant="destructive">banned</Badge>}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-4">
          {selected && <UserDetail key={selected} id={selected} />}
          <IpBanForm />
          <BanList />
        </div>
      </div>
    </>
  );
}

function useBanMutations() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const ban = useMutation({
    mutationFn: (body: CreateBanBody) => adminApi.ban(body),
    onSuccess: async () => {
      toast.success('Ban created');
      await refresh();
    },
    onError: (e) => toast.error(friendlyError(e)),
  });
  const unban = useMutation({
    mutationFn: (id: number) => adminApi.unban(id),
    onSuccess: async () => {
      toast.success('Ban lifted');
      await refresh();
    },
    onError: (e) => toast.error(friendlyError(e)),
  });
  return { ban, unban };
}

function BanFields({
  reason,
  setReason,
  minutes,
  setMinutes,
}: {
  reason: string;
  setReason: (v: string) => void;
  minutes: number | null;
  setMinutes: (v: number | null) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_9rem]">
      <Input
        placeholder="Reason (optional)"
        aria-label="Reason"
        maxLength={300}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Select
        value={String(minutes)}
        onValueChange={(v) => setMinutes(v === 'null' ? null : Number(v))}
      >
        <SelectTrigger aria-label="Duration" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {durations.map((d) => (
            <SelectItem
              key={d.label}
              value={String(d.minutes)}
              disabled={d.minutes !== null && d.minutes > MAX_BAN_MINUTES}
            >
              {d.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function UserDetail({ id }: { id: string }) {
  const user = useQuery({ queryKey: ['admin', 'user', id], queryFn: () => adminApi.user(id) });
  const { ban, unban } = useBanMutations();
  const kick = useMutation({
    mutationFn: (code: string) => adminApi.kick(code, id),
    onSuccess: () => toast.success('Removed from the room'),
    onError: (e) => toast.error(friendlyError(e)),
  });
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState<number | null>(60 * 24);

  if (!user.data) return <QueryState isPending={user.isPending} error={user.error} />;
  const u = user.data;
  const active = u.bans.find((b) => b.active);

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-3">
        <UserAvatar avatar={u.avatar} name={u.displayName} />
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{u.displayName}</h2>
          <p className="truncate font-mono text-sm text-muted-foreground">{u.id}</p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Joined {formatTime(u.createdAt)} · IPs now: {u.ips.length ? u.ips.join(', ') : 'offline'}
      </p>
      {u.rooms.map((r) => (
        <div key={r.code} className="flex items-center justify-between gap-2 text-sm">
          <span>
            In <span className="font-medium">{r.name}</span> ({r.code})
          </span>
          <Button size="sm" variant="outline" onClick={() => kick.mutate(r.code)}>
            Kick
          </Button>
        </div>
      ))}
      {active ? (
        <div className="space-y-2">
          <p className="text-sm">
            <Badge variant="destructive">banned</Badge>{' '}
            {active.expiresAt ? `until ${formatTime(active.expiresAt)}` : 'permanently'}
            {active.reason && ` · ${active.reason}`}
          </p>
          <Button size="sm" variant="outline" onClick={() => unban.mutate(active.id)}>
            Lift ban
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <BanFields {...{ reason, setReason, minutes, setMinutes }} />
          <Button
            size="sm"
            variant="destructive"
            disabled={ban.isPending}
            onClick={() =>
              ban.mutate({
                type: 'user',
                value: u.id,
                reason: reason || undefined,
                durationMinutes: minutes,
              })
            }
          >
            Ban user
          </Button>
        </div>
      )}
    </Card>
  );
}

function IpBanForm() {
  const { ban } = useBanMutations();
  const [ip, setIp] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState<number | null>(60 * 24);
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold">Ban an IP address</h2>
      <Input
        placeholder="203.0.113.7"
        aria-label="IP address"
        value={ip}
        onChange={(e) => setIp(e.target.value)}
      />
      <BanFields {...{ reason, setReason, minutes, setMinutes }} />
      <Button
        size="sm"
        variant="destructive"
        disabled={!ip.trim() || ban.isPending}
        onClick={() =>
          ban.mutate(
            { type: 'ip', value: ip.trim(), reason: reason || undefined, durationMinutes: minutes },
            { onSuccess: () => setIp('') },
          )
        }
      >
        Ban IP
      </Button>
    </Card>
  );
}

function BanList() {
  const { unban } = useBanMutations();
  const [all, setAll] = useState(false);
  const bans = useQuery({ queryKey: ['admin', 'bans', all], queryFn: () => adminApi.bans(all) });
  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Bans</h2>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          Include ended
        </label>
      </div>
      <QueryState isPending={bans.isPending} error={bans.error} />
      {bans.data?.length === 0 && <Empty>No bans.</Empty>}
      <ul className="divide-y">
        {bans.data?.map((b: AdminBan) => (
          <li key={b.id} className="flex items-center gap-2 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="truncate">
                <Badge variant="outline">{b.type}</Badge> {b.userName ?? b.value}
              </p>
              <p className="truncate text-sm text-muted-foreground">
                {b.expiresAt ? `until ${formatTime(b.expiresAt)}` : 'permanent'}
                {b.reason && ` · ${b.reason}`}
                {!b.active && ' · ended'}
              </p>
            </div>
            {b.active && (
              <Button size="sm" variant="ghost" onClick={() => unban.mutate(b.id)}>
                Lift
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
