import { useQuery } from '@tanstack/react-query';
import { Card, PageHeader, QueryState } from './ui';
import { adminApi } from './admin-api';

/** YouTube Data API v3 default daily allowance. */
const DAILY_QUOTA_UNITS = 10_000;

export function QuotaPage() {
  const quota = useQuery({ queryKey: ['admin', 'quota'], queryFn: adminApi.quota });
  const q = quota.data;
  const max = Math.max(1, ...(q?.days.map((d) => d.units) ?? []));

  return (
    <>
      <PageHeader title="Quota" />
      <QueryState isPending={quota.isPending} error={quota.error} />
      {q && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
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
          </div>
          <Card>
            <h2 className="font-semibold">Last 14 days</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              Quota units per day (Pacific Time).
            </p>
            <div
              className="flex h-40 items-end gap-1.5"
              role="img"
              aria-label={`Quota units per day, highest ${max}`}
            >
              {q.days.map((d) => (
                <div
                  key={d.date}
                  className="group relative flex h-full flex-1 items-end"
                  title={`${d.date}: ${d.units} units, ${d.searchCalls} searches`}
                >
                  <div
                    className="w-full rounded-t-sm bg-foreground/70 group-hover:bg-foreground"
                    style={{ height: `${(d.units / max) * 100}%`, minHeight: d.units > 0 ? 2 : 0 }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-xs text-muted-foreground">
              <span>{q.days[0]?.date}</span>
              <span>{q.days.at(-1)?.date}</span>
            </div>
            <table className="mt-4 w-full text-sm">
              <caption className="sr-only">Daily quota usage</caption>
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Date</th>
                  <th className="py-1 text-right font-medium">Units</th>
                  <th className="py-1 text-right font-medium">Searches</th>
                </tr>
              </thead>
              <tbody>
                {[...q.days].reverse().map((d) => (
                  <tr key={d.date} className="border-t">
                    <td className="py-1">{d.date}</td>
                    <td className="py-1 text-right tabular-nums">{d.units}</td>
                    <td className="py-1 text-right tabular-nums">{d.searchCalls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
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
}: {
  label: string;
  value: number;
  limit: number;
  unit: string;
}) {
  const pct = limit > 0 ? Math.min(100, (value / limit) * 100) : 100;
  return (
    <Card>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="font-display text-2xl font-extrabold tabular-nums">
        {value}{' '}
        <span className="text-base font-normal text-muted-foreground">
          / {limit} {unit}
        </span>
      </p>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={limit}
      >
        <div
          className={pct >= 90 ? 'h-full bg-destructive' : 'h-full bg-foreground/70'}
          style={{ width: `${pct}%` }}
        />
      </div>
    </Card>
  );
}
