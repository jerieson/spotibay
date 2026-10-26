import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { adminApi } from './admin-api';
import { Card, Empty, formatTime, PageHeader, QueryState } from './ui';

/** Radix Select reserves the empty string, so "no filter" needs its own value. */
const ALL = '__all';

function FilterSelect({
  label,
  allLabel,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  allLabel: string;
  options: readonly string[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? '' : v)}>
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const actions = [
  'settings.update',
  'room.close',
  'room.join_override',
  'user.kick',
  'ban.create',
  'ban.remove',
  'chat.delete',
];
const targetTypes = ['setting', 'room', 'user', 'ip', 'message'];

export function AuditPage() {
  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const log = useInfiniteQuery({
    queryKey: ['admin', 'audit', action, targetType],
    queryFn: ({ pageParam }) =>
      adminApi.audit({
        action: action || undefined,
        targetType: targetType || undefined,
        before: pageParam,
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <>
      <PageHeader title="Audit Log" />
      <div className="mb-4 flex flex-wrap gap-2">
        <FilterSelect
          label="Action"
          allLabel="All actions"
          options={actions}
          value={action}
          onChange={setAction}
          className="w-48"
        />
        <FilterSelect
          label="Target type"
          allLabel="All targets"
          options={targetTypes}
          value={targetType}
          onChange={setTargetType}
          className="w-40"
        />
      </div>
      <QueryState isPending={log.isPending} error={log.error} />
      {log.data && entries.length === 0 && <Empty>Nothing recorded yet.</Empty>}
      <Card className="divide-y p-0">
        {entries.map((e) => (
          <div key={e.id} className="space-y-1 p-3 text-sm">
            <p>
              <span className="font-mono font-medium">{e.action}</span>
              {e.targetId && (
                <span className="text-muted-foreground">
                  {' '}
                  · {e.targetType} {e.targetId}
                </span>
              )}
            </p>
            <p className="text-sm text-muted-foreground">
              {e.adminUsername ?? 'unknown'} · {formatTime(e.createdAt)}
            </p>
            {Object.keys(e.details).length > 0 && (
              <pre className="overflow-x-auto rounded-md bg-muted p-2 text-sm">
                {JSON.stringify(e.details)}
              </pre>
            )}
          </div>
        ))}
      </Card>
      {log.hasNextPage && (
        <Button
          className="mt-3"
          variant="outline"
          disabled={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </>
  );
}
