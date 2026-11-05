import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  DoorOpen,
  ListMusic,
  Music2,
  Search,
  UserPlus,
  Users,
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DASHBOARD_RECENT_DAYS, type AdminDashboard } from '@spotibay/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { adminApi } from './admin-api';
import {
  ChartCard,
  ColumnChart,
  DAILY_QUOTA_UNITS,
  RankedBars,
  Sparkline,
  TrendChart,
  formatDay,
  formatHour,
} from './charts';
import { adminStatsKey } from './layout';
import { Card, Empty, PageHeader, QueryState } from './ui';

const days = (rows: { date: string; count: number }[]) =>
  rows.map((r) => ({ key: r.date, tick: formatDay(r.date), value: r.count }));
const dayTable = (rows: { date: string; count: number }[], column: string) => ({
  columns: ['Day', column] as [string, string],
  rows: [...rows].reverse().map((r): [string, number] => [formatDay(r.date), r.count]),
});

export function DashboardPage() {
  // The socket keeps this fresh; the query gives the first paint.
  const stats = useQuery({ queryKey: adminStatsKey, queryFn: adminApi.stats, staleTime: Infinity });
  const quota = useQuery({ queryKey: ['admin', 'quota'], queryFn: adminApi.quota });
  const dashboard = useQuery({
    queryKey: ['admin', 'dashboard'],
    queryFn: adminApi.dashboard,
    refetchInterval: 30_000,
  });
  const d = dashboard.data;

  const plays = d?.playsPerDay.map((p) => p.count);
  const signups = d?.newUsersPerDay.map((p) => p.count);
  const tiles: Tile[] = [
    { label: 'Open rooms', icon: DoorOpen, value: stats.data?.rooms, live: true },
    { label: 'Users online', icon: Wifi, value: stats.data?.usersOnline, live: true },
    { label: 'Plays today', icon: Music2, value: d?.totals.playsToday, trend: plays },
    { label: 'New users today', icon: UserPlus, value: d?.totals.newUsersToday, trend: signups },
    { label: 'Active in 24 hours', icon: Activity, value: d?.totals.activeUsers },
    { label: 'All users', icon: Users, value: d?.totals.users },
    { label: 'Playlists', icon: ListMusic, value: d?.totals.playlists },
    {
      label: 'Searches today',
      icon: Search,
      value: quota.data && `${quota.data.today.searchCalls} / ${quota.data.searchCallBudget}`,
    },
  ];
  const today = d?.playsPerDay.at(-1)?.date;

  return (
    <>
      <PageHeader title="Dashboard">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LiveDot />
          <span>
            Live
            {dashboard.dataUpdatedAt > 0 && (
              <>
                {' '}
                · updated <Ago at={dashboard.dataUpdatedAt} />
              </>
            )}
            {d && <> · days and hours in {d.timeZone}</>}
          </span>
        </p>
      </PageHeader>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <StatTile key={t.label} tile={t} />
        ))}
      </div>
      <div className="mt-4">
        <QueryState isPending={dashboard.isPending} error={dashboard.error} />
      </div>
      {d && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ChartCard
            title="Plays per day"
            description="Songs played to the end, last 14 days."
            table={dayTable(d.playsPerDay, 'Plays')}
          >
            <ColumnChart data={days(d.playsPerDay)} label="Plays" highlight={today} />
          </ChartCard>
          <ChartCard
            title="Busiest hours"
            description={`Plays by hour of day, last ${DASHBOARD_RECENT_DAYS} days.`}
            table={{
              columns: ['Hour', 'Plays'],
              rows: d.playsByHour.map((h) => [formatHour(h.hour), h.count]),
            }}
          >
            <ColumnChart
              data={d.playsByHour.map((h) => ({
                key: String(h.hour),
                tick: formatHour(h.hour),
                value: h.count,
              }))}
              label="Plays"
              tickInterval={2}
              highlight={hourIn(d.timeZone)}
            />
          </ChartCard>
          <ChartCard
            title="New users per day"
            description="Guest accounts created, last 14 days."
            table={dayTable(d.newUsersPerDay, 'New users')}
          >
            <ColumnChart
              data={days(d.newUsersPerDay)}
              label="New users"
              highlight={d.newUsersPerDay.at(-1)?.date}
            />
          </ChartCard>
          <MatchSources sources={d.matchSources} />
          {quota.data && (
            <ChartCard
              className="lg:col-span-2"
              title="YouTube quota"
              description={
                <>
                  Units used per day (Pacific Time). Allowance {DAILY_QUOTA_UNITS.toLocaleString()}{' '}
                  a day.{' '}
                  <Link to="/admin/quota" className="underline underline-offset-2">
                    Details
                  </Link>
                </>
              }
              table={{
                columns: ['Day', 'Units'],
                rows: [...quota.data.days]
                  .reverse()
                  .map((q): [string, number] => [formatDay(q.date), q.units]),
              }}
            >
              <TrendChart
                data={quota.data.days.map((q) => ({
                  key: q.date,
                  tick: formatDay(q.date),
                  value: q.units,
                }))}
                label="Units"
                hue="chart-2"
                limit={{ value: DAILY_QUOTA_UNITS, label: 'Allowance' }}
              />
            </ChartCard>
          )}
          <TopTracks tracks={d.topTracks} />
          <TopRooms rooms={d.topRooms} />
        </div>
      )}
    </>
  );
}

interface Tile {
  label: string;
  icon: LucideIcon;
  value: number | string | undefined;
  /** Kept fresh over the socket. */
  live?: boolean;
  /** The last days, oldest first; the last entry is today. */
  trend?: number[];
}

function StatTile({ tile }: { tile: Tile }) {
  const { label, icon: Icon, value, live, trend } = tile;
  const yesterday = trend?.at(-2);
  const now = trend?.at(-1);
  const change =
    yesterday !== undefined && now !== undefined && yesterday > 0
      ? Math.round(((now - yesterday) / yesterday) * 100)
      : null;
  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{label}</p>
        {live ? <LiveDot /> : <Icon className="size-4 text-muted-foreground" aria-hidden />}
      </div>
      <p className="mt-1 font-display text-3xl font-extrabold tabular-nums">
        {typeof value === 'number' ? value.toLocaleString() : (value ?? '–')}
      </p>
      {change !== null && (
        <p className="text-xs text-muted-foreground">
          {change > 0 ? '+' : ''}
          {change}% vs yesterday
        </p>
      )}
      {trend && trend.some((v) => v > 0) && (
        <div className="mt-auto pt-2">
          <Sparkline values={trend} label={label} />
        </div>
      )}
    </Card>
  );
}

/** The hour of day now in `timeZone`, as the busiest-hours chart keys it ("0" to "23"). */
function hourIn(timeZone: string): string {
  const hour = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date());
  return String(Number(hour));
}

/** A pulsing dot: this number updates by itself. */
function LiveDot() {
  return (
    <span className="relative flex size-2" aria-hidden>
      <span className="live-dot absolute inline-flex size-full animate-ping rounded-full bg-chart-1 opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-chart-1" />
    </span>
  );
}

/** "12s ago", ticking. */
function Ago({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const sec = Math.max(0, Math.round((now - at) / 1000));
  return <>{sec < 60 ? `${sec}s ago` : `${Math.round(sec / 60)}m ago`}</>;
}

const sourceLabels: Record<keyof AdminDashboard['matchSources'], string> = {
  cache: 'Already matched',
  links: 'Song links (Odesli, MusicBrainz)',
  search: 'YouTube search',
  none: 'No match found',
};

function MatchSources({ sources }: { sources: AdminDashboard['matchSources'] }) {
  const total = sources.cache + sources.links + sources.search + sources.none;
  const free = sources.cache + sources.links;
  const data = (Object.keys(sourceLabels) as (keyof typeof sourceLabels)[]).map((k) => ({
    label: sourceLabels[k],
    value: sources[k],
  }));
  return (
    <ChartCard
      title="How suggested songs were matched"
      description={
        total > 0
          ? `${free.toLocaleString()} of ${total.toLocaleString()} found without a YouTube search (100 units each), last ${DASHBOARD_RECENT_DAYS} days.`
          : `Last ${DASHBOARD_RECENT_DAYS} days.`
      }
    >
      {total > 0 ? <RankedBars data={data} /> : <Empty>No suggested songs picked yet.</Empty>}
    </ChartCard>
  );
}

function TopTracks({ tracks }: { tracks: AdminDashboard['topTracks'] }) {
  return (
    <Card className="self-start">
      <h2 className="font-semibold">Top songs</h2>
      <p className="mb-2 text-sm text-muted-foreground">
        Most played, last {DASHBOARD_RECENT_DAYS} days.
      </p>
      {tracks.length === 0 ? (
        <Empty>Nothing played yet.</Empty>
      ) : (
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">#</TableHead>
              <TableHead>Song</TableHead>
              <TableHead className="w-16 text-right">Plays</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tracks.map((t, i) => (
              <TableRow key={t.videoId}>
                <TableCell className="text-muted-foreground tabular-nums">{i + 1}</TableCell>
                <TableCell className="whitespace-normal">
                  <div className="flex min-w-0 items-center gap-3">
                    <img
                      src={t.thumbnailUrl}
                      alt=""
                      className="size-9 shrink-0 rounded-md object-cover"
                    />
                    <div className="min-w-0">
                      <p className="truncate font-medium">{t.title}</p>
                      <p className="truncate text-muted-foreground">{t.channelTitle}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{t.plays}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function TopRooms({ rooms }: { rooms: AdminDashboard['topRooms'] }) {
  return (
    <Card className="self-start">
      <h2 className="font-semibold">Busiest rooms</h2>
      <p className="mb-2 text-sm text-muted-foreground">
        Most plays, last {DASHBOARD_RECENT_DAYS} days.
      </p>
      {rooms.length === 0 ? (
        <Empty>No plays yet.</Empty>
      ) : (
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>Room</TableHead>
              <TableHead className="w-16 text-right">Plays</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rooms.map((r) => (
              <TableRow key={r.code}>
                <TableCell className="whitespace-normal">
                  <p className="truncate font-medium">{r.name}</p>
                  <p className="text-muted-foreground">
                    {r.code} · {r.open ? 'open' : 'closed'}
                  </p>
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.plays}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
