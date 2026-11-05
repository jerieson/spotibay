import { useId, useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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

/** Which chart hue a chart's one series wears: violet for activity, blue for YouTube quota. */
export type ChartHue = 'chart-1' | 'chart-2';

const valueConfig = (label: string, hue: ChartHue): ChartConfig => ({
  value: { label, color: `var(--${hue})` },
});

/** An id for a chart's gradient that is safe inside `url(#…)` (React's ids hold `«»` or `:`). */
function useFadeId(): string {
  return `fade-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/** A top-to-bottom fade of the series colour, for bars and areas. */
function Fade({ id, from, to }: { id: string; from: number; to: number }) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="var(--color-value)" stopOpacity={from} />
        <stop offset="100%" stopColor="var(--color-value)" stopOpacity={to} />
      </linearGradient>
    </defs>
  );
}

/** 7500 -> `7.5k`, so the axis stays narrow. */
const compact = (n: number) => (n >= 1000 ? `${n / 1000}k` : String(n));

const axisProps = { tickLine: false, axisLine: false, tickMargin: 8 } as const;

/** One count per category along the bottom (days, hours): thin bars, rounded at the top. */
export function ColumnChart({
  data,
  label,
  tickInterval = 'preserveStartEnd',
  hue = 'chart-1',
  highlight,
}: {
  data: { key: string; tick: string; value: number }[];
  /** What a bar counts, for the tooltip. */
  label: string;
  tickInterval?: number | 'preserveStartEnd';
  hue?: ChartHue;
  /** The bar drawn solid (today, or this hour); the others fade. */
  highlight?: string;
}) {
  const fade = useFadeId();
  return (
    <ChartContainer config={valueConfig(label, hue)} className="aspect-auto h-52 w-full">
      <BarChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }} barCategoryGap={2}>
        <Fade id={fade} from={0.95} to={0.35} />
        <CartesianGrid vertical={false} />
        <XAxis dataKey="tick" {...axisProps} interval={tickInterval} minTickGap={8} />
        <YAxis {...axisProps} width={32} allowDecimals={false} tickFormatter={compact} />
        <ChartTooltip
          cursor={{ fill: 'var(--muted)', opacity: 0.5 }}
          content={<ChartTooltipContent />}
        />
        <Bar
          dataKey="value"
          className="chart-glow"
          radius={[4, 4, 0, 0]}
          maxBarSize={28}
          animationDuration={700}
        >
          {data.map((d) => (
            <Cell key={d.key} fill={d.key === highlight ? 'var(--color-value)' : `url(#${fade})`} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

/** A daily amount over time as a filled line, with an optional limit drawn when it's in range. */
export function TrendChart({
  data,
  label,
  limit,
  hue = 'chart-1',
}: {
  data: { key: string; tick: string; value: number }[];
  label: string;
  limit?: { value: number; label: string };
  hue?: ChartHue;
}) {
  const fade = useFadeId();
  return (
    <ChartContainer config={valueConfig(label, hue)} className="aspect-auto h-52 w-full">
      <AreaChart data={data} margin={{ top: 12, right: 4, left: 4, bottom: 0 }}>
        <Fade id={fade} from={0.4} to={0} />
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
          className="chart-glow"
          stroke="var(--color-value)"
          strokeWidth={2}
          fill={`url(#${fade})`}
          activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
          animationDuration={900}
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
              className="h-full rounded-r-[4px] bg-gradient-to-r from-chart-1/50 to-chart-1 transition-[width] duration-700 ease-out"
              style={{ width: `${(d.value / max) * 100}%`, minWidth: d.value > 0 ? 4 : 0 }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A tiny trend with no axes, for a stat tile: the shape of the last days at a glance. */
export function Sparkline({
  values,
  label,
  hue = 'chart-1',
}: {
  values: number[];
  label: string;
  hue?: ChartHue;
}) {
  const fade = useFadeId();
  const data = values.map((value, i) => ({ i, value }));
  return (
    <ChartContainer
      config={valueConfig(label, hue)}
      className="aspect-auto h-10 w-full"
      aria-hidden
    >
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <Fade id={fade} from={0.35} to={0} />
        <Area
          dataKey="value"
          type="monotone"
          className="chart-glow"
          stroke="var(--color-value)"
          strokeWidth={2}
          fill={`url(#${fade})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}
