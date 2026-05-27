import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiGet } from "@/lib/api";
import { PageSkeleton } from "@/components/page-skeleton";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface AdoptionData {
  range: { start: string; end: string; timezone: string };
  summary: {
    workspaceMembers: number;
    everTalked: number;
    dau: number;
    wau: number;
    mau: number;
    previousDau: number;
    previousWau: number;
    previousMau: number;
    powerUsers: number;
    newUsers7d: number;
    newUsers28d: number;
    returningMauUsers: number;
    dmMessages28d: number;
    mentionMessages28d: number;
    totalMessages7d: number;
    week1EligibleUsers: number;
    week1ReturnedUsers: number;
    dauMauRatio: number;
    wauMauRatio: number;
    reachPct: number;
    returningMauRate: number;
    week1Retention: number;
    dmShare: number;
    mentionShare: number;
  };
  deltas: {
    dauWow: number;
    wauWow: number;
    mauPreviousPeriod: number;
  };
  activity: Array<{
    date: string;
    isWeekend: boolean;
    dau: number;
    wau: number;
    mau: number;
    dauMauRatio: number;
    wauMauRatio: number;
  }>;
  funnel: Array<{
    stage: string;
    count: number;
    shareOfWorkspace: number;
    conversionFromPrevious: number;
    dropOffFromPrevious: number;
  }>;
  cohorts: Array<{
    cohortWeek: string;
    cohortSize: number;
    retention: Array<{ weekOffset: number; activeUsers: number; retentionPct: number }>;
  }>;
  teams: Array<{
    team: string;
    memberCount: number;
    dau: number;
    wau: number;
    mau: number;
    mauPct: number;
    dormantUsers: number;
    topUser: { userId: string; displayName: string | null; messages28d: number } | null;
  }>;
  topUsers: Array<{
    userId: string;
    displayName: string | null;
    team: string;
    messages7d: number;
    activeDays7d: number;
    lastSeen: string;
  }>;
  dormantUsers: Array<{
    userId: string;
    displayName: string | null;
    team: string;
    lastSeen: string;
    previousMessages: number;
  }>;
  depth: {
    activeUsers7d: number;
    totalMessages7d: number;
    p50Messages: number;
    p90Messages: number;
    p99Messages: number;
    histogram: Array<{ bucket: string; users: number }>;
  };
}

type AdoptionSearch = {
  start?: string;
  end?: string;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatLocalYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseLocalYMD(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function defaultDateRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 179);
  return { start: formatLocalYMD(start), end: formatLocalYMD(end) };
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatDelta(value: number): string {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : ""}${value.toLocaleString()}`;
}

function formatShortDate(date: string): string {
  return format(parseLocalYMD(date), "LLL d");
}

function getRetentionColor(retentionPct: number, weekOffset: number): string {
  if (weekOffset === 0) return "bg-primary text-primary-foreground";
  if (retentionPct >= 70) return "bg-emerald-600 text-white";
  if (retentionPct >= 50) return "bg-emerald-500/80 text-white";
  if (retentionPct >= 30) return "bg-emerald-400/70 text-foreground";
  if (retentionPct >= 15) return "bg-amber-300/70 text-foreground";
  if (retentionPct > 0) return "bg-muted text-foreground";
  return "bg-muted/40 text-muted-foreground";
}

function AdoptionPage() {
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  const [defaultRange] = useState(defaultDateRange);

  const committed =
    search.start && search.end
      ? { start: search.start, end: search.end }
      : defaultRange;

  const [range, setRange] = useState<DateRange | undefined>(() => ({
    from: parseLocalYMD(committed.start),
    to: parseLocalYMD(committed.end),
  }));

  useEffect(() => {
    if (search.start && search.end) return;
    navigate({
      replace: true,
      search: (prev) => ({
        ...prev,
        start: defaultRange.start,
        end: defaultRange.end,
      }),
    });
  }, [defaultRange.end, defaultRange.start, navigate, search.end, search.start]);

  useEffect(() => {
    setRange({
      from: parseLocalYMD(committed.start),
      to: parseLocalYMD(committed.end),
    });
  }, [committed.end, committed.start]);

  const rangeInvalid = committed.start > committed.end;

  const resetRange = useCallback(() => {
    navigate({
      search: (prev) => ({
        ...prev,
        start: defaultRange.start,
        end: defaultRange.end,
      }),
    });
  }, [defaultRange.end, defaultRange.start, navigate]);

  const handleRangeSelect = useCallback((next: DateRange | undefined) => {
    setRange(next);
    const from = next?.from;
    const to = next?.to;
    if (!from || !to) return;
    navigate({
      search: (prev) => ({
        ...prev,
        start: formatLocalYMD(from),
        end: formatLocalYMD(to),
      }),
    });
  }, [navigate]);

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ["adoption", committed.start, committed.end],
    queryFn: () =>
      apiGet<AdoptionData>("/adoption", {
        start: committed.start,
        end: committed.end,
      }),
    enabled: !rangeInvalid,
  });

  const chartData = useMemo(() => {
    if (!data) return [];
    const maxMau = Math.max(...data.activity.map((day) => day.mau), 1);
    return data.activity.map((day) => ({
      date: formatShortDate(day.date),
      fullDate: day.date,
      dau: day.dau,
      wau: day.wau,
      mau: day.mau,
      dauMauRatio: day.dauMauRatio,
      wauMauRatio: day.wauMauRatio,
      weekendMarker: day.isWeekend ? maxMau : 0,
      dayType: day.isWeekend ? "Weekend" : "Weekday",
    }));
  }, [data]);

  if (isLoading) return <PageSkeleton />;
  if (rangeInvalid) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <h1 className="text-lg font-semibold tracking-tight">Adoption</h1>
          <DateRangeControls
            range={range}
            onRangeSelect={handleRangeSelect}
            onReset={resetRange}
          />
        </div>
        <p className="text-sm text-destructive">Start date must be on or before end date.</p>
      </div>
    );
  }
  if (error) return <div className="text-destructive text-sm">Failed to load adoption data: {error.message}</div>;
  if (!data) return null;

  const rangeDescription = `${format(parseLocalYMD(committed.start), "LLL d, y")} – ${format(parseLocalYMD(committed.end), "LLL d, y")}`;
  const maxFunnelCount = Math.max(...data.funnel.map((step) => step.count), 1);
  const maxCohortWeek = Math.max(0, ...data.cohorts.flatMap((cohort) => cohort.retention.map((cell) => cell.weekOffset)));
  const cohortWeekOffsets = Array.from({ length: maxCohortWeek + 1 }, (_, index) => index);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Adoption</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Traction, retention, and depth inside RealAdvisor. Dates use {data.range.timezone}.
          </p>
          <p className="text-xs text-muted-foreground mt-1">{rangeDescription}</p>
        </div>
        <DateRangeControls
          range={range}
          onRangeSelect={handleRangeSelect}
          onReset={resetRange}
          isFetching={isFetching}
        />
      </div>

      <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="DAU"
          value={formatNumber(data.summary.dau)}
          detail={`${formatDelta(data.deltas.dauWow)} vs same weekday last week`}
        />
        <MetricCard
          title="WAU"
          value={formatNumber(data.summary.wau)}
          detail={`${formatDelta(data.deltas.wauWow)} vs prior 7-day window`}
        />
        <MetricCard
          title="MAU"
          value={formatNumber(data.summary.mau)}
          detail={`${formatDelta(data.deltas.mauPreviousPeriod)} vs prior 28-day window`}
        />
        <MetricCard
          title="DAU / MAU"
          value={formatPct(data.summary.dauMauRatio)}
          detail="30% is the internal work-tool benchmark"
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Activity volume</CardTitle>
            <p className="text-xs text-muted-foreground">DAU, rolling 7-day WAU, and rolling 28-day MAU. Pale bars mark weekends.</p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" className="text-xs" minTickGap={24} />
                <YAxis className="text-xs" allowDecimals={false} />
                <Tooltip content={<AdoptionTooltip />} />
                <Legend />
                <Bar dataKey="weekendMarker" name="Weekend" fill="#e5e7eb" fillOpacity={0.35} barSize={8} />
                <Line type="monotone" dataKey="dau" name="DAU" stroke="#2563eb" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="wau" name="WAU" stroke="#16a34a" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="mau" name="MAU" stroke="#9333ea" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Stickiness</CardTitle>
            <p className="text-xs text-muted-foreground">DAU/MAU and WAU/MAU ratios with 20%, 30%, and 50% reference lines.</p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" className="text-xs" minTickGap={28} />
                <YAxis className="text-xs" domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
                <Tooltip content={<AdoptionTooltip percentKeys={["dauMauRatio", "wauMauRatio"]} />} />
                <Legend />
                <ReferenceLine y={20} stroke="#94a3b8" strokeDasharray="4 4" label="20%" />
                <ReferenceLine y={30} stroke="#f59e0b" strokeDasharray="4 4" label="30%" />
                <ReferenceLine y={50} stroke="#10b981" strokeDasharray="4 4" label="50%" />
                <Line type="monotone" dataKey="dauMauRatio" name="DAU/MAU" stroke="#f97316" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="wauMauRatio" name="WAU/MAU" stroke="#0ea5e9" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Penetration funnel</CardTitle>
            <p className="text-xs text-muted-foreground">Workspace reach through active and power usage. Power users are active on at least 5 days in the last 7.</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.funnel.map((step) => (
              <div key={step.stage} className="space-y-1">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">{step.stage}</span>
                  <span>{formatNumber(step.count)}</span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/75"
                    style={{ width: `${Math.max(2, (step.count / maxFunnelCount) * 100)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{formatPct(step.shareOfWorkspace)} of workspace</span>
                  <span>{step.dropOffFromPrevious === 0 ? "Start" : `${formatPct(step.dropOffFromPrevious)} drop-off`}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Depth of engagement</CardTitle>
            <p className="text-xs text-muted-foreground">Messages per active user in the last 7 days.</p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-2 pb-3">
              <MiniStat label="P50" value={data.depth.p50Messages.toFixed(0)} />
              <MiniStat label="P90" value={data.depth.p90Messages.toFixed(0)} />
              <MiniStat label="P99" value={data.depth.p99Messages.toFixed(0)} />
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.depth.histogram}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="bucket" className="text-xs" />
                <YAxis className="text-xs" allowDecimals={false} />
                <Tooltip content={<AdoptionTooltip />} />
                <Bar dataKey="users" name="Users" fill="#2563eb" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Weekly cohort retention</CardTitle>
          <p className="text-xs text-muted-foreground">
            Cohorts are based on first-ever message to Aura. Cells show the share returning in each subsequent week.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <div
              className="grid min-w-max gap-1 text-xs"
              style={{ gridTemplateColumns: `8rem repeat(${cohortWeekOffsets.length}, minmax(3rem, 1fr))` }}
            >
              <div className="font-medium text-muted-foreground">Cohort</div>
              {cohortWeekOffsets.map((offset) => (
                <div key={offset} className="text-center font-medium text-muted-foreground">W{offset}</div>
              ))}
              {data.cohorts.map((cohort) => {
                const cells = new Map(cohort.retention.map((cell) => [cell.weekOffset, cell]));
                return (
                  <CohortRow
                    key={cohort.cohortWeek}
                    cohortWeek={cohort.cohortWeek}
                    cohortSize={cohort.cohortSize}
                    weekOffsets={cohortWeekOffsets}
                    cells={cells}
                  />
                );
              })}
            </div>
          </div>
          {data.cohorts.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">No cohorts in this range.</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 xl:grid-cols-3">
        <MetricCard
          title="Week-1 retention"
          value={formatPct(data.summary.week1Retention)}
          detail={`${formatNumber(data.summary.week1ReturnedUsers)} of ${formatNumber(data.summary.week1EligibleUsers)} eligible users returned`}
        />
        <MetricCard
          title="Returning MAU"
          value={formatPct(data.summary.returningMauRate)}
          detail={`${formatNumber(data.summary.returningMauUsers)} current MAU were active in the prior 28 days`}
        />
        <MetricCard
          title="DM share"
          value={formatPct(data.summary.dmShare)}
          detail={`${formatNumber(data.summary.dmMessages28d)} DMs vs ${formatNumber(data.summary.mentionMessages28d)} mentions in 28d`}
        />
      </div>

      <Card className="gap-0 overflow-hidden p-0">
        <CardHeader className="px-6 pt-6 pb-4">
          <CardTitle className="text-base">Team adoption</CardTitle>
          <p className="text-xs text-muted-foreground">Team comes from users.known_facts.team when available.</p>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-0 hover:bg-transparent">
                  <TableHead>Team</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                  <TableHead className="text-right">DAU</TableHead>
                  <TableHead className="text-right">WAU</TableHead>
                  <TableHead className="text-right">MAU</TableHead>
                  <TableHead className="text-right">MAU %</TableHead>
                  <TableHead>Top user</TableHead>
                  <TableHead className="text-right">Dormant</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr]:border-0">
                {data.teams.map((team) => (
                  <TableRow key={team.team}>
                    <TableCell className="py-2 font-medium">{team.team}</TableCell>
                    <TableCell className="py-2 text-right">{formatNumber(team.memberCount)}</TableCell>
                    <TableCell className="py-2 text-right">{formatNumber(team.dau)}</TableCell>
                    <TableCell className="py-2 text-right">{formatNumber(team.wau)}</TableCell>
                    <TableCell className="py-2 text-right">{formatNumber(team.mau)}</TableCell>
                    <TableCell className="py-2 text-right">{formatPct(team.mauPct)}</TableCell>
                    <TableCell className="py-2">
                      {team.topUser ? (
                        <UserLink userId={team.topUser.userId} label={team.topUser.displayName || team.topUser.userId} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="py-2 text-right">{formatNumber(team.dormantUsers)}</TableCell>
                  </TableRow>
                ))}
                {data.teams.length === 0 && (
                  <TableRow className="border-0 hover:bg-transparent">
                    <TableCell colSpan={8} className="py-4 text-center text-muted-foreground">No team data</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 xl:grid-cols-2">
        <UserTableCard title="Top users this week" emptyLabel="No active users this week">
          {data.topUsers.map((user) => (
            <TableRow key={user.userId}>
              <TableCell className="py-2">
                <UserLink userId={user.userId} label={user.displayName || user.userId} />
              </TableCell>
              <TableCell className="py-2">{user.team}</TableCell>
              <TableCell className="py-2 text-right">{formatNumber(user.messages7d)}</TableCell>
              <TableCell className="py-2 text-right">{formatNumber(user.activeDays7d)}</TableCell>
              <TableCell className="py-2 text-right">{formatShortDate(user.lastSeen)}</TableCell>
            </TableRow>
          ))}
        </UserTableCard>

        <UserTableCard title="Dormant users" emptyLabel="No dormant users">
          {data.dormantUsers.map((user) => (
            <TableRow key={user.userId}>
              <TableCell className="py-2">
                <UserLink userId={user.userId} label={user.displayName || user.userId} />
              </TableCell>
              <TableCell className="py-2">{user.team}</TableCell>
              <TableCell className="py-2 text-right">{formatNumber(user.previousMessages)}</TableCell>
              <TableCell className="py-2 text-right" colSpan={2}>{formatShortDate(user.lastSeen)}</TableCell>
            </TableRow>
          ))}
        </UserTableCard>
      </div>
    </div>
  );
}

function MetricCard({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <Card>
      <CardHeader className="space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function CohortRow({
  cohortWeek,
  cohortSize,
  weekOffsets,
  cells,
}: {
  cohortWeek: string;
  cohortSize: number;
  weekOffsets: number[];
  cells: Map<number, { weekOffset: number; activeUsers: number; retentionPct: number }>;
}) {
  return (
    <>
      <div className="flex flex-col justify-center rounded-md bg-muted/40 px-2 py-1">
        <span className="font-medium">{formatShortDate(cohortWeek)}</span>
        <span className="text-[11px] text-muted-foreground">{formatNumber(cohortSize)} users</span>
      </div>
      {weekOffsets.map((offset) => {
        const cell = cells.get(offset);
        if (!cell) return <div key={offset} className="rounded-md bg-transparent" />;
        return (
          <div
            key={offset}
            className={`flex min-h-9 items-center justify-center rounded-md px-1 py-1 text-center font-medium ${getRetentionColor(cell.retentionPct, offset)}`}
            title={`${cell.activeUsers} users retained in W${offset}`}
          >
            {formatPct(cell.retentionPct)}
          </div>
        );
      })}
    </>
  );
}

function UserLink({ userId, label }: { userId: string; label: string }) {
  return (
    <Link
      to="/users/$slackUserId"
      params={{ slackUserId: userId }}
      className="font-medium hover:underline"
    >
      {label}
    </Link>
  );
}

function UserTableCard({ title, emptyLabel, children }: { title: string; emptyLabel: string; children: React.ReactNode }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <CardHeader className="px-6 pt-6 pb-4">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-0 hover:bg-transparent">
                <TableHead>User</TableHead>
                <TableHead>Team</TableHead>
                <TableHead className="text-right">Messages</TableHead>
                <TableHead className="text-right">Days</TableHead>
                <TableHead className="text-right">Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_tr]:border-0">
              {hasRows ? children : (
                <TableRow className="border-0 hover:bg-transparent">
                  <TableCell colSpan={5} className="py-4 text-center text-muted-foreground">{emptyLabel}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function AdoptionTooltip({
  active,
  payload,
  label,
  percentKeys = [],
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; dataKey?: string; payload?: { fullDate?: string; dayType?: string } }>;
  label?: string;
  percentKeys?: string[];
}) {
  if (!active || !payload?.length) return null;
  const visiblePayload = payload.filter((item) => item.dataKey !== "weekendMarker");
  const fullDate = payload[0]?.payload?.fullDate;
  const dayType = payload[0]?.payload?.dayType;
  return (
    <div className="rounded-lg border bg-background p-2 text-xs shadow-sm">
      <div className="font-medium">{fullDate ?? label}</div>
      {dayType && <div className="text-muted-foreground">{dayType}</div>}
      <div className="mt-1 space-y-0.5">
        {visiblePayload.map((item) => {
          const dataKey = String(item.dataKey ?? "");
          const value = Number(item.value ?? 0);
          return (
            <div key={`${dataKey}-${item.name}`} className="flex justify-between gap-4">
              <span>{item.name ?? dataKey}</span>
              <span className="font-medium">{percentKeys.includes(dataKey) ? formatPct(value) : formatNumber(value)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DateRangeControls({
  range,
  onRangeSelect,
  onReset,
  isFetching,
}: {
  range: DateRange | undefined;
  onRangeSelect: (r: DateRange | undefined) => void;
  onReset: () => void;
  isFetching?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:flex-wrap sm:justify-end">
      <div className="flex flex-col gap-1.5 sm:items-end">
        <span className="text-xs text-muted-foreground sm:text-right">Date range</span>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              id="adoption-date-range"
              className="min-w-[16rem] justify-start gap-2 px-2.5 font-normal"
            >
              <CalendarIcon className="size-4 shrink-0 opacity-70" />
              {range?.from ? (
                range.to ? (
                  <>
                    {format(range.from, "LLL dd, y")} – {format(range.to, "LLL dd, y")}
                  </>
                ) : (
                  format(range.from, "LLL dd, y")
                )
              ) : (
                <span className="text-muted-foreground">Pick a date range</span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto max-w-[calc(100vw-2rem)] overflow-x-auto p-0" align="end">
            <Calendar
              mode="range"
              showOutsideDays={false}
              defaultMonth={range?.from}
              selected={range}
              onSelect={onRangeSelect}
              resetOnSelect
              numberOfMonths={2}
            />
          </PopoverContent>
        </Popover>
      </div>
      <Button type="button" variant="outline" size="sm" className="sm:mb-0.5" onClick={onReset}>
        Last 180 days
      </Button>
      {isFetching ? (
        <span className="text-xs text-muted-foreground sm:mb-2">Updating…</span>
      ) : null}
    </div>
  );
}

export const Route = createFileRoute("/adoption/")({
  validateSearch: (raw: Record<string, unknown>) => {
    const start = typeof raw.start === "string" && ISO_DATE_RE.test(raw.start) ? raw.start : undefined;
    const end = typeof raw.end === "string" && ISO_DATE_RE.test(raw.end) ? raw.end : undefined;
    return {
      start: start && end ? start : undefined,
      end: start && end ? end : undefined,
    } satisfies AdoptionSearch;
  },
  component: AdoptionPage,
});
