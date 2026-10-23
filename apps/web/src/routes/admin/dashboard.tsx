import { useQuery } from '@tanstack/react-query';
import { adminApi } from './admin-api';
import { adminStatsKey } from './layout';
import { Card, PageHeader } from './ui';

export function DashboardPage() {
  // The socket keeps this fresh; the query gives the first paint.
  const stats = useQuery({ queryKey: adminStatsKey, queryFn: adminApi.stats, staleTime: Infinity });
  const quota = useQuery({ queryKey: ['admin', 'quota'], queryFn: adminApi.quota });
  const tiles = [
    { label: 'Open rooms', value: stats.data?.rooms },
    { label: 'Users online', value: stats.data?.usersOnline },
    {
      label: 'Searches today',
      value: quota.data && `${quota.data.today.searchCalls} / ${quota.data.searchCallBudget}`,
    },
    { label: 'Quota units today', value: quota.data?.today.units },
  ];

  return (
    <>
      <PageHeader title="Dashboard" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label}>
            <p className="text-sm text-muted-foreground">{t.label}</p>
            <p className="mt-1 font-display text-3xl font-extrabold tabular-nums">
              {t.value ?? '–'}
            </p>
          </Card>
        ))}
      </div>
    </>
  );
}
