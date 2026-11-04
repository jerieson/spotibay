import { useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card } from './ui';

/** `2026-11-04` -> `Nov 4`, read as a calendar day (no time zone shift). */
export function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** 0 -> `12am`, 13 -> `1pm`. */
export function formatHour(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 ? 'am' : 'pm'}`;
}

const number = (n: number) => n.toLocaleString();

/** YouTube Data API v3 default daily allowance. */
export const DAILY_QUOTA_UNITS = 10_000;

export interface TableView {
  columns: [string, string];
  rows: [string, number][];
}

/**
 * A titled chart that can switch to a table of the same numbers, so nothing is read from the
 * picture alone.
 */
export function ChartCard({
  title,
  description,
  table,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  table?: TableView;
  children: ReactNode;
  className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Card className={className}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {table && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-2"
            aria-pressed={asTable}
            onClick={() => setAsTable((v) => !v)}
          >
            {asTable ? 'Chart' : 'Table'}
          </Button>
        )}
      </div>
      {asTable && table ? (
        <div className="max-h-64 overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{table.columns[0]}</TableHead>
                <TableHead className="text-right">{table.columns[1]}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.rows.map(([label, value]) => (
                <TableRow key={label}>
                  <TableCell>{label}</TableCell>
                  <TableCell className="text-right tabular-nums">{number(value)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        children
      )}
    </Card>
  );
}

const valueConfig = (label: string): ChartConfig => ({
  value: { label, color: 'var(--chart-1)' },
});

/** 7500 -> `7.5k`, so the axis stays narrow. */
const compact = (n: number) => (n >= 1000 ? `${n / 1000}k` : String(n));

const axisProps = { tickLine: false, axisLine: false, tickMargin: 8 } as const;

/** One count per category along the bottom (days, hours): thin bars, rounded at the top. */
export function ColumnChart({
  data,
  label,
  tickInterval = 'preserveStartEnd',
}: {
  data: { key: string; tick: string; value: number }[];
  /** What a bar counts, for the tooltip. */
  label: string;
  tickInterval?: number | 'preserveStartEnd';
}) {
  return (
    <ChartContainer config={valueConfig(label)} className="aspect-auto h-52 w-full">
      <BarChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="tick" {...axisProps} interval={tickInterval} minTickGap={8} />
        <YAxis {...axisProps} width={32} allowDecimals={false} tickFormatter={compact} />
        <ChartTooltip cursor content={<ChartTooltipContent />} />
        <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ChartContainer>
  );
}

/** A daily amount over time as a filled line, with an optional limit drawn when it's in range. */
export function TrendChart({
  data,
  label,
  limit,
}: {
  data: { key: string; tick: string; value: number }[];
  label: string;
  limit?: { value: number; label: string };
}) {
  return (
    <ChartContainer config={valueConfig(label)} className="aspect-auto h-52 w-full">
      <AreaChart data={data} margin={{ top: 12, right: 4, left: 4, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="tick" {...axisProps} interval="preserveStartEnd" minTickGap={8} />
        <YAxis {...axisProps} width={36} allowDecimals={false} tickFormatter={compact} />
        <ChartTooltip cursor content={<ChartTooltipContent indicator="line" />} />
        {limit && (
          <ReferenceLine
            y={limit.value}
            ifOverflow="discard"
            stroke="var(--muted-foreground)"
            strokeDasharray="4 4"
            label={{
              value: limit.label,
              position: 'insideTopRight',
              fill: 'var(--muted-foreground)',
              fontSize: 12,
            }}
          />
        )}
        <Area
          dataKey="value"
          type="monotone"
          stroke="var(--color-value)"
          strokeWidth={2}
          fill="var(--color-value)"
          fillOpacity={0.15}
          activeDot={{ r: 4 }}
        />
      </AreaChart>
    </ChartContainer>
  );
}

/** Parts compared with each other: one bar per part, largest first, the value at its end. */
export function RankedBars({ data }: { data: { label: string; value: number }[] }) {
  const ranked = [...data].sort((a, b) => b.value - a.value);
  const max = Math.max(1, ...ranked.map((d) => d.value));
  return (
    <ul className="space-y-3">
      {ranked.map((d) => (
        <li key={d.label} className="text-sm" title={`${d.label}: ${number(d.value)}`}>
          <div className="mb-1 flex justify-between gap-2">
            <span>{d.label}</span>
            <span className="font-medium tabular-nums">{number(d.value)}</span>
          </div>
          <div className="h-2 rounded-r-[4px] bg-muted">
            <div
              className="h-full rounded-r-[4px] bg-chart-1"
              style={{ width: `${(d.value / max) * 100}%`, minWidth: d.value > 0 ? 4 : 0 }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
