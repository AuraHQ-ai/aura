import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { PageSkeleton } from "@/components/page-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, truncate } from "@/lib/utils";

const failureClasses = [
  "all",
  "missing_cred",
  "bad_memory",
  "bad_harness",
  "missing_tool",
  "reasoning",
  "latency",
  "none",
] as const;

type FailureClass = (typeof failureClasses)[number];

interface EvalSummaryData {
  filters: {
    failureClass: string | null;
    servingIntent: string | null;
    userId: string | null;
  };
  summary: {
    total: number;
    scorable: number;
    fulfilled: number;
    partial: number;
    failed: number;
    ratifiedFailed: number;
    costUsd: number;
  };
  byFailureClass: Array<{
    failureClass: string;
    count: number;
    failed: number;
  }>;
  byServingIntent: Array<{
    servingIntent: string | null;
    count: number;
    failed: number;
    costUsd: number;
  }>;
  recentFailures: Array<{
    partId: string;
    traceId: string;
    threadTs: string | null;
    servingIntent: string | null;
    failureClass: string;
    note: string | null;
    ratifiedBy: string | null;
    createdAt: string;
    userId: string | null;
    channelId: string | null;
    costUsd: string | null;
    displayName: string | null;
  }>;
}

type EvalSearch = {
  failureClass?: FailureClass;
  servingIntent?: string;
  userId?: string;
};

function formatPct(numerator: number, denominator: number): string {
  if (denominator <= 0) return "0.0%";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function formatCost(value: number | string | null): string {
  const n = Number(value ?? 0);
  return n > 0 ? `$${n.toFixed(4)}` : "—";
}

function EvalPage() {
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  const [servingIntent, setServingIntent] = useState(search.servingIntent ?? "");
  const [userId, setUserId] = useState(search.userId ?? "");

  useEffect(() => {
    setServingIntent(search.servingIntent ?? "");
    setUserId(search.userId ?? "");
  }, [search.servingIntent, search.userId]);

  const failureClass = search.failureClass ?? "all";
  const { data, isLoading, error } = useQuery({
    queryKey: ["eval-scores", "summary", search],
    queryFn: () =>
      apiGet<EvalSummaryData>("/eval-scores/summary", {
        failureClass,
        servingIntent: search.servingIntent,
        userId: search.userId,
      }),
  });

  function applyFilters() {
    navigate({
      search: () => ({
        failureClass,
        servingIntent: servingIntent.trim() || undefined,
        userId: userId.trim() || undefined,
      }),
    });
  }

  function setFailureClass(next: FailureClass) {
    navigate({
      search: (prev) => ({
        ...prev,
        failureClass: next,
      }),
    });
  }

  if (isLoading) return <PageSkeleton />;
  if (error)
    return (
      <div className="text-destructive text-sm">
        Failed to load eval funnel: {error.message}
      </div>
    );
  if (!data) return null;

  const funnel = [
    { stage: "Processed", count: data.summary.total },
    { stage: "Scorable", count: data.summary.scorable },
    { stage: "Failed", count: data.summary.failed },
    { stage: "Ratified failed", count: data.summary.ratifiedFailed },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Eval funnel</h1>
        <p className="text-sm text-muted-foreground">
          Response-level judge scores over persisted Aura interactions.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-sm">
            <span className="font-medium">Failure class</span>
            <select
              value={failureClass}
              onChange={(event) => setFailureClass(event.target.value as FailureClass)}
              className="h-9 rounded-md border bg-background px-3 text-sm"
            >
              {failureClasses.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Serving intent contains</span>
            <Input
              value={servingIntent}
              onChange={(event) => setServingIntent(event.target.value)}
              placeholder="e.g. draft follow-up"
              className="w-64"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">User ID</span>
            <Input
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder="U..."
              className="w-48"
            />
          </label>
          <Button onClick={applyFilters}>Apply</Button>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardHeader>
            <CardTitle>Total</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {data.summary.total.toLocaleString()}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Scorable</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {data.summary.scorable.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground">
              {formatPct(data.summary.scorable, data.summary.total)} of processed
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Failed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {data.summary.failed.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground">
              {formatPct(data.summary.failed, data.summary.scorable)} of scorable
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Ratified failed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {data.summary.ratifiedFailed.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground">
              Feeds curated bench candidates
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Cost</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {formatCost(data.summary.costUsd)}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Funnel</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {funnel.map((stage, index) => {
            const previous = index === 0 ? stage.count : funnel[index - 1].count;
            const width = data.summary.total > 0 ? Math.max(4, (stage.count / data.summary.total) * 100) : 0;
            return (
              <div key={stage.stage} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span>{stage.stage}</span>
                  <span className="font-mono">
                    {stage.count.toLocaleString()} · {formatPct(stage.count, previous)}
                  </span>
                </div>
                <div className="h-3 rounded-full bg-muted">
                  <div className="h-3 rounded-full bg-primary" style={{ width: `${width}%` }} />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By failure class</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Class</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byFailureClass.map((row) => (
                  <TableRow key={row.failureClass}>
                    <TableCell>
                      <Badge variant="outline">{row.failureClass}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">{row.count}</TableCell>
                    <TableCell className="text-right font-mono">{row.failed}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>By serving intent</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Intent</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byServingIntent.map((row) => (
                  <TableRow key={row.servingIntent ?? "unknown"}>
                    <TableCell>{truncate(row.servingIntent ?? "—", 80)}</TableCell>
                    <TableCell className="text-right font-mono">{row.count}</TableCell>
                    <TableCell className="text-right font-mono">{row.failed}</TableCell>
                    <TableCell className="text-right font-mono">{formatCost(row.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent failures</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Failure</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Intent</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>Trace</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recentFailures.map((row) => (
                <TableRow key={row.partId}>
                  <TableCell className="space-y-1">
                    <Badge variant="destructive">{row.failureClass}</Badge>
                    <div className="text-xs text-muted-foreground">
                      {formatDate(row.createdAt)}
                    </div>
                    {row.ratifiedBy && <Badge variant="secondary">ratified</Badge>}
                  </TableCell>
                  <TableCell>
                    <div>{row.displayName ?? row.userId ?? "—"}</div>
                    {row.channelId && (
                      <div className="text-xs text-muted-foreground font-mono">
                        {row.channelId}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{truncate(row.servingIntent ?? "—", 100)}</TableCell>
                  <TableCell>{truncate(row.note ?? "—", 120)}</TableCell>
                  <TableCell>
                    <Button variant="outline" size="sm" asChild>
                      <Link to="/conversations/$id" params={{ id: row.traceId }}>
                        Open
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/eval/")({
  component: EvalPage,
  validateSearch: (raw: Record<string, unknown>): EvalSearch => ({
    failureClass: failureClasses.includes(raw.failureClass as FailureClass)
      ? (raw.failureClass as FailureClass)
      : "all",
    servingIntent: typeof raw.servingIntent === "string" ? raw.servingIntent : undefined,
    userId: typeof raw.userId === "string" ? raw.userId : undefined,
  }),
});
