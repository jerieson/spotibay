import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { adminApi } from './admin-api';
import { Card, Empty, formatTime, PageHeader, QueryState, Select } from './ui';

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
        <Select
          aria-label="Action"
          className="w-48"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        >
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </Select>
        <Select
          aria-label="Target type"
          className="w-40"
          value={targetType}
          onChange={(e) => setTargetType(e.target.value)}
        >
          <option value="">All targets</option>
          {targetTypes.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </Select>
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
            <p className="text-xs text-muted-foreground">
              {e.adminUsername ?? 'unknown'} · {formatTime(e.createdAt)}
            </p>
            {Object.keys(e.details).length > 0 && (
              <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
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
