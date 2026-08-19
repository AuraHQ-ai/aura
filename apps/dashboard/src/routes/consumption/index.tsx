import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { apiGet } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageSkeleton } from "@/components/page-skeleton";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface ConsumptionData {
  dailyCost: Array<{ date: string; cost: number; conversations: number }>;
  perUser: Array<{
    userId: string;
    displayName: string | null;
    interactiveCost: number;
    jobCost: number;
    totalCost: number;
    conversations: number;
  }>;
  perJob: Array<{
    jobId: string;
    jobName: string | null;
    creatorName: string | null;
    executionCount: number;
    totalCost: number;
  }>;
  totals: { totalCost: number; conversations: number; avgDailyCost: number };
  tokenBreakdown: {
    cacheRead: number;
    cacheWrite: number;
    uncached: number;
    output: number;
  };
}

type ConsumptionSearch = {
  start?: string;
  end?: string;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const chartUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  return cost < 0.01 ? "< $0.01" : usdFormatter.format(cost);
}

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
  start.setDate(start.getDate() - 29);
  return { start: formatLocalYMD(start), end: formatLocalYMD(end) };
}

function ConsumptionPage() {
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
    queryKey: ["consumption", committed.start, committed.end],
    queryFn: () =>
      apiGet<ConsumptionData>("/consumption", {
        start: committed.start,
        end: committed.end,
      }),
    enabled: !rangeInvalid,
  });

  if (isLoading) return <PageSkeleton />;
  if (rangeInvalid) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <h1 className="text-lg font-semibold tracking-tight">Consumption</h1>
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
  if (error) return <div className="text-destructive text-sm">Failed to load consumption data: {error.message}</div>;
  if (!data) return null;

  const rangeDescription = `${format(parseLocalYMD(committed.start), "LLL d, y")} – ${format(parseLocalYMD(committed.end), "LLL d, y")}`;

  const chartData = data.dailyCost.map((d) => ({
    date: d.date.slice(5),
    cost: Number(d.cost.toFixed(4)),
    conversations: d.conversations,
  }));

  const totalTokens =
    data.tokenBreakdown.cacheRead +
    data.tokenBreakdown.cacheWrite +
    data.tokenBreakdown.uncached +
    data.tokenBreakdown.output;
  const userTotalCost = data.perUser.reduce((sum, user) => sum + user.totalCost, 0);
  const jobTotalCost = data.perJob.reduce((sum, job) => sum + job.totalCost, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Consumption</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{rangeDescription}</p>
        </div>
        <DateRangeControls
          range={range}
          onRangeSelect={handleRangeSelect}
          onReset={resetRange}
          isFetching={isFetching}
        />
      </div>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{formatCost(data.totals.totalCost)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Conversations</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{data.totals.conversations.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Daily Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{formatCost(data.totals.avgDailyCost)}</div>
            <p className="text-xs text-muted-foreground mt-1">Across days with usage in range</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily cost</CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" className="text-xs" />
                <YAxis className="text-xs" tickFormatter={(v) => chartUsdFormatter.format(v)} />
                <Tooltip
                  contentStyle={{
                    background: "var(--bg)",
                    border: "1px solid var(--col-border)",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  formatter={(value: number, name: string) =>
                    name === "Cost" ? [chartUsdFormatter.format(value), name] : [value.toLocaleString(), name]
                  }
                />
                <Area
                  type="monotone"
                  dataKey="cost"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.1}
                  name="Cost"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No cost data yet. Costs will appear after conversations with cost tracking are processed.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="h-full max-h-[43rem] gap-0 overflow-hidden p-0">
          <CostTableCardHeader
            title="Cost by User"
            totalCost={userTotalCost}
            itemCount={data.perUser.length}
            itemLabel="users"
          />
          <CardContent className="min-h-0 flex-1 px-0 pb-0">
            <div className="h-full overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-0 hover:bg-transparent">
                    <TableHead>User</TableHead>
                    <TableHead className="w-[100px] text-right">Interactive</TableHead>
                    <TableHead className="w-[100px] text-right">Jobs</TableHead>
                    <TableHead className="w-[100px] text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="[&_tr]:border-0">
                  {data.perUser.map((u) => (
                    <TableRow key={u.userId}>
                      <TableCell className="py-2">
                        <CostShareLabel
                          label={
                            <Link
                              to="/users/$slackUserId"
                              params={{ slackUserId: u.userId }}
                              className="truncate font-medium hover:underline"
                            >
                              {u.displayName || u.userId}
                            </Link>
                          }
                          share={userTotalCost > 0 ? (u.totalCost / userTotalCost) * 100 : 0}
                        />
                      </TableCell>
                      <TableCell className="py-2 text-right">{formatCost(u.interactiveCost)}</TableCell>
                      <TableCell className="py-2 text-right">{formatCost(u.jobCost)}</TableCell>
                      <TableCell className="py-2 text-right font-medium">{formatCost(u.totalCost)}</TableCell>
                    </TableRow>
                  ))}
                  {data.perUser.length === 0 && (
                    <TableRow className="border-0 hover:bg-transparent">
                      <TableCell colSpan={4} className="py-4 text-center text-muted-foreground">No data</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card className="h-full max-h-[43rem] gap-0 overflow-hidden p-0">
          <CostTableCardHeader
            title="Cost by Job"
            totalCost={jobTotalCost}
            itemCount={data.perJob.length}
            itemLabel="jobs"
          />
          <CardContent className="min-h-0 flex-1 px-0 pb-0">
            <div className="h-full overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-0 hover:bg-transparent">
                    <TableHead>Job</TableHead>
                    <TableHead className="w-[140px]">Creator</TableHead>
                    <TableHead className="w-[80px] text-right">Runs</TableHead>
                    <TableHead className="w-[100px] text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="[&_tr]:border-0">
                  {data.perJob.map((j) => (
                    <TableRow key={j.jobId}>
                      <TableCell className="py-2">
                        <CostShareLabel
                          label={
                            <Link
                              to="/jobs/$id"
                              params={{ id: j.jobId }}
                              className="truncate font-medium hover:underline"
                            >
                              {j.jobName || "Unknown"}
                            </Link>
                          }
                          share={jobTotalCost > 0 ? (j.totalCost / jobTotalCost) * 100 : 0}
                        />
                      </TableCell>
                      <TableCell className="py-2">{j.creatorName || "—"}</TableCell>
                      <TableCell className="py-2 text-right">{j.executionCount}</TableCell>
                      <TableCell className="py-2 text-right font-medium">{formatCost(j.totalCost)}</TableCell>
                    </TableRow>
                  ))}
                  {data.perJob.length === 0 && (
                    <TableRow className="border-0 hover:bg-transparent">
                      <TableCell colSpan={4} className="py-4 text-center text-muted-foreground">No data</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {totalTokens > 0 && (
        <div className="space-y-3">
          <div>
            <h2 className="text-sm font-medium tracking-tight">Token Statistics</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Total tokens processed across the selected date range
            </p>
          </div>
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Cache Read</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xl font-bold">{data.tokenBreakdown.cacheRead.toLocaleString()}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Cache Write</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xl font-bold">{data.tokenBreakdown.cacheWrite.toLocaleString()}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Uncached Input</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xl font-bold">{data.tokenBreakdown.uncached.toLocaleString()}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Output</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xl font-bold">{data.tokenBreakdown.output.toLocaleString()}</div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function CostShareLabel({
  label,
  share,
}: {
  label: ReactNode;
  share: number;
}) {
  const width = Math.max(share, share > 0 ? 2 : 0);

  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{label}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{share.toFixed(1)}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted/70">
        <div
          className="h-full rounded-full bg-primary/70"
          style={{ width: `${Math.min(width, 100)}%` }}
        />
      </div>
    </div>
  );
}

function CostTableCardHeader({
  title,
  totalCost,
  itemCount,
  itemLabel,
}: {
  title: string;
  totalCost: number;
  itemCount: number;
  itemLabel: string;
}) {
  return (
    <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 px-6 pt-6 pb-4">
      <CardTitle className="text-base">{title}</CardTitle>
      <div className="text-right">
        <div className="text-sm font-medium">{formatCost(totalCost)}</div>
        <p className="text-xs text-muted-foreground">
          {itemCount.toLocaleString()} {itemLabel}
        </p>
      </div>
    </CardHeader>
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
              id="consumption-date-range"
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
        Last 30 days
      </Button>
      {isFetching ? (
        <span className="text-xs text-muted-foreground sm:mb-2">Updating…</span>
      ) : null}
    </div>
  );
}

export const Route = createFileRoute("/consumption/")({
  validateSearch: (raw: Record<string, unknown>) => {
    const start = typeof raw.start === "string" && ISO_DATE_RE.test(raw.start) ? raw.start : undefined;
    const end = typeof raw.end === "string" && ISO_DATE_RE.test(raw.end) ? raw.end : undefined;
    return {
      start: start && end ? start : undefined,
      end: start && end ? end : undefined,
    } satisfies ConsumptionSearch;
  },
  component: ConsumptionPage,
});
