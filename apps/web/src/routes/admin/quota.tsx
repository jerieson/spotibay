import { useQuery } from '@tanstack/react-query';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ChartCard, DAILY_QUOTA_UNITS, TrendChart, formatDay } from './charts';
import { Card, PageHeader, QueryState } from './ui';
import { adminApi } from './admin-api';

export function QuotaPage() {
  const quota = useQuery({ queryKey: ['admin', 'quota'], queryFn: adminApi.quota });
  const q = quota.data;

  return (
    <>
      <PageHeader title="Quota" />
      <QueryState isPending={quota.isPending} error={quota.error} />
      {q && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Meter
              label="Search calls today"
              value={q.today.searchCalls}
              limit={q.searchCallBudget}
              unit="calls"
            />
            <Meter
              label="Quota units today"
              value={q.today.units}
              limit={DAILY_QUOTA_UNITS}
              unit="units"
            />
            <Meter
              label="Autoplay searches today"
              value={q.autoplay.searches}
              limit={q.autoplay.searchCap}
              unit="calls"
              note={`Autoplay queued ${q.autoplay.queued.toLocaleString()} ${q.autoplay.queued === 1 ? 'song' : 'songs'} today and found nothing ${q.autoplay.stalled.toLocaleString()} ${q.autoplay.stalled === 1 ? 'time' : 'times'}.`}
            />
          </div>
          <ChartCard
            title="Last 14 days"
            description={`Quota units per day (Pacific Time). Allowance ${DAILY_QUOTA_UNITS.toLocaleString()} a day.`}
          >
            <TrendChart
              data={q.days.map((d) => ({ key: d.date, tick: formatDay(d.date), value: d.units }))}
              label="Units"
              limit={{ value: DAILY_QUOTA_UNITS, label: 'Allowance' }}
            />
            <Table className="mt-4">
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead className="text-right">Searches</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...q.days].reverse().map((d) => (
                  <TableRow key={d.date}>
                    <TableCell>{d.date}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.units.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{d.searchCalls}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ChartCard>
        </div>
      )}
    </>
  );
}

function Meter({
  label,
  value,
  limit,
  unit,
  note,
}: {
  label: string;
  value: number;
  limit: number;
  unit: string;
  note?: string;
}) {
  const pct = limit > 0 ? Math.min(100, (value / limit) * 100) : 100;
  return (
    <Card>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="font-display text-2xl font-extrabold tabular-nums">
        {value.toLocaleString()}{' '}
        <span className="text-base font-normal text-muted-foreground">
          / {limit.toLocaleString()} {unit}
        </span>
      </p>
      <Progress
        value={pct}
        aria-label={label}
        className="mt-2 bg-muted"
        indicatorClassName={pct >= 90 ? 'bg-destructive' : 'bg-chart-1'}
      />
      {pct >= 90 && <p className="mt-1 text-sm text-destructive">Almost used up for today.</p>}
      {note && <p className="mt-1 text-sm text-muted-foreground">{note}</p>}
    </Card>
  );
}
