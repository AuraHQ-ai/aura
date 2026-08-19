import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableRowsSkeleton } from "@/components/page-skeleton";
import { Pagination } from "@/components/pagination";
import {
  VerdictBadge,
  FailureClassBadge,
  type EvalScore,
} from "@/components/eval-verdict-badge";
import { cn, formatDate, truncate } from "@/lib/utils";
import { useState } from "react";
import { Search, CheckCircle } from "lucide-react";

interface EvalScoreListItem extends EvalScore {
  userId: string | null;
  channelId: string | null;
  modelId: string | null;
  costUsd: string | null;
  respondedAt: string;
  resolvedName: string | null;
}

interface FunnelData {
  totals: {
    total: number;
    scorable: number;
    fulfilled: number;
    partial: number;
    failed: number;
    ratified: number;
  };
  byFailureClass: { failureClass: string; count: number; costUsd: number }[];
  byIntent: { servingIntent: string | null; count: number; failed: number }[];
  byUser: {
    userId: string | null;
    count: number;
    failed: number;
    costUsd: number;
    resolvedName: string | null;
  }[];
}

const PAGE_SIZE = 50;

const FAILURE_CLASSES = [
  "missing_cred",
  "bad_memory",
  "bad_harness",
  "missing_tool",
  "reasoning",
  "latency",
  "none",
];

function FunnelCards({ funnel }: { funnel: FunnelData | undefined }) {
  if (!funnel) return null;
  const { totals } = funnel;
  return (
    <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
      <Card>
        <CardHeader>
          <CardTitle>Scored</CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-lg font-semibold">{totals.total.toLocaleString()}</span>
          <span className="text-xs text-muted-foreground block">
            {totals.scorable.toLocaleString()} scorable
          </span>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Fulfilled</CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-lg font-semibold text-green-600 dark:text-green-400">
            {totals.fulfilled.toLocaleString()}
          </span>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Partial</CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-lg font-semibold text-yellow-600 dark:text-yellow-400">
            {totals.partial.toLocaleString()}
          </span>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Failed</CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-lg font-semibold text-destructive">
            {totals.failed.toLocaleString()}
          </span>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Ratified</CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-lg font-semibold">{totals.ratified.toLocaleString()}</span>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Top failure class</CardTitle>
        </CardHeader>
        <CardContent>
          {funnel.byFailureClass.length > 0 ? (
            <div className="text-sm space-y-0.5">
              {funnel.byFailureClass.slice(0, 3).map((row) => (
                <div key={row.failureClass} className="flex justify-between gap-2">
                  <span className="truncate">{row.failureClass.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground">{row.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EvalsPage() {
  const [search, setSearch] = useState("");
  const [verdictFilter, setVerdictFilter] = useState("all");
  const [classFilter, setClassFilter] = useState("all");
  const [scorableFilter, setScorableFilter] = useState("true");
  const [ratifiedFilter, setRatifiedFilter] = useState("all");
  const [page, setPage] = useState(1);

  const { data: funnel } = useQuery({
    queryKey: ["eval-funnel"],
    queryFn: () => apiGet<FunnelData>("/eval/funnel"),
  });

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: [
      "eval-scores",
      search,
      verdictFilter,
      classFilter,
      scorableFilter,
      ratifiedFilter,
      page,
    ],
    queryFn: () =>
      apiGet<{ items: EvalScoreListItem[]; total: number }>("/eval", {
        search: search || undefined,
        verdict: verdictFilter !== "all" ? verdictFilter : undefined,
        failureClass: classFilter !== "all" ? classFilter : undefined,
        scorable: scorableFilter !== "all" ? scorableFilter : undefined,
        ratified: ratifiedFilter !== "all" ? ratifiedFilter : undefined,
        page: String(page),
        limit: String(PAGE_SIZE),
      }),
    placeholderData: keepPreviousData,
  });

  if (error && !data)
    return (
      <div className="text-destructive text-sm">
        Failed to load eval scores: {error.message}
      </div>
    );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Evals</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "…" : `${total} total`}
        </span>
      </div>

      <FunnelCards funnel={funnel} />

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search intent or note..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9"
          />
        </div>
        <Select
          value={verdictFilter}
          onValueChange={(v) => {
            setVerdictFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All verdicts</SelectItem>
            <SelectItem value="fulfilled">Fulfilled</SelectItem>
            <SelectItem value="partial">Partial</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={classFilter}
          onValueChange={(v) => {
            setClassFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All classes</SelectItem>
            {FAILURE_CLASSES.map((fc) => (
              <SelectItem key={fc} value={fc}>
                {fc.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={scorableFilter}
          onValueChange={(v) => {
            setScorableFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All turns</SelectItem>
            <SelectItem value="true">Scorable</SelectItem>
            <SelectItem value="false">Not scorable</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={ratifiedFilter}
          onValueChange={(v) => {
            setRatifiedFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any ratification</SelectItem>
            <SelectItem value="true">Ratified</SelectItem>
            <SelectItem value="false">Unratified</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div
        className={cn(
          "flex-1 min-h-0 rounded-xl border overflow-auto transition-opacity",
          isFetching && !isLoading && "opacity-50",
        )}
      >
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[90px]">Verdict</TableHead>
              <TableHead className="w-[130px]">Failure class</TableHead>
              <TableHead>Serving intent</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="w-[140px]">User</TableHead>
              <TableHead className="w-[70px]">Ratified</TableHead>
              <TableHead className="w-[150px]">Responded</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRowsSkeleton columns={7} />
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center text-muted-foreground py-8"
                >
                  No response scores yet — the overnight batch judge fills this
                  in.
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Link to="/evals/$id" params={{ id: item.id }}>
                      <VerdictBadge
                        verdict={item.verdict}
                        scorable={item.scorable}
                        className="cursor-pointer"
                      />
                    </Link>
                  </TableCell>
                  <TableCell>
                    <FailureClassBadge failureClass={item.failureClass} />
                  </TableCell>
                  <TableCell className="text-sm">
                    <Link
                      to="/evals/$id"
                      params={{ id: item.id }}
                      className="hover:underline"
                    >
                      {truncate(item.servingIntent, 60) || "—"}
                    </Link>
                    {item.resolvedInWindow && (
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        resolved in window
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {truncate(item.note, 80) || "—"}
                  </TableCell>
                  <TableCell className="text-sm">
                    {item.resolvedName ?? item.userId ?? "—"}
                  </TableCell>
                  <TableCell>
                    {item.ratifiedBy ? (
                      <CheckCircle
                        className="h-4 w-4 text-green-600 dark:text-green-400"
                        aria-label={`Ratified by ${item.ratifiedBy}`}
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDate(item.respondedAt)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination
        total={total}
        pageSize={PAGE_SIZE}
        page={page}
        onPageChange={setPage}
      />
    </div>
  );
}

export const Route = createFileRoute("/evals/")({
  component: EvalsPage,
});
