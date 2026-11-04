import { useQuery } from '@tanstack/react-query';
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
    refetchInterval: 60_000,
  });
  const d = dashboard.data;

  const tiles = [
    { label: 'Open rooms', value: stats.data?.rooms },
    { label: 'Users online', value: stats.data?.usersOnline },
    { label: 'Plays today', value: d?.totals.playsToday },
    { label: 'New users today', value: d?.totals.newUsersToday },
    { label: 'Active in 24 hours', value: d?.totals.activeUsers },
    { label: 'All users', value: d?.totals.users },
    { label: 'Playlists', value: d?.totals.playlists },
    {
      label: 'Searches today',
      value: quota.data && `${quota.data.today.searchCalls} / ${quota.data.searchCallBudget}`,
    },
  ];

  return (
    <>
      <PageHeader title="Dashboard">
        {d && <p className="text-sm text-muted-foreground">Days and hours in {d.timeZone}</p>}
      </PageHeader>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label}>
            <p className="text-sm text-muted-foreground">{t.label}</p>
            <p className="mt-1 font-display text-3xl font-extrabold tabular-nums">
              {typeof t.value === 'number' ? t.value.toLocaleString() : (t.value ?? '–')}
            </p>
          </Card>
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
            <ColumnChart data={days(d.playsPerDay)} label="Plays" />
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
            />
          </ChartCard>
          <ChartCard
            title="New users per day"
            description="Guest accounts created, last 14 days."
            table={dayTable(d.newUsersPerDay, 'New users')}
          >
            <ColumnChart data={days(d.newUsersPerDay)} label="New users" />
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
