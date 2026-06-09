import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableRowsSkeleton } from "@/components/page-skeleton";
import { Pagination } from "@/components/pagination";
import { cn, truncate } from "@/lib/utils";
import { Search } from "lucide-react";

const PAGE_SIZE = 25;

interface Funnel {
  byVerdict: { verdict: string | null; count: number }[];
  byFailureClass: { failureClass: string; count: number }[];
  byIntent: { servingIntent: string | null; count: number }[];
  byUser: {
    userId: string | null;
    resolvedName: string | null;
    failed: number;
    total: number;
    costUsd: number;
  }[];
  totals: { scorable: number; total: number; ratifiedFailed: number };
}

interface ScoreRow {
  id: string;
  traceId: string | null;
  verdict: string | null;
  scorable: boolean;
  servingIntent: string | null;
  failureClass: string;
  note: string | null;
  ratifiedBy: string | null;
  channelId: string | null;
  userId: string | null;
  resolvedName: string | null;
  costUsd: string | null;
  responseText: string | null;
}

const VERDICT_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  fulfilled: "default",
  partial: "outline",
  failed: "destructive",
};

function FunnelCards({ funnel }: { funnel: Funnel }) {
  const verdictCounts = Object.fromEntries(
    funnel.byVerdict.map((v) => [v.verdict ?? "null", v.count]),
  );
  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader>
          <CardTitle>Scorable responses</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-semibold">{funnel.totals.scorable}</div>
          <div className="text-xs text-muted-foreground">
            of {funnel.totals.total} judged
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Verdicts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5 text-sm">
            <Badge variant="default">{verdictCounts["fulfilled"] ?? 0} fulfilled</Badge>
            <Badge variant="outline">{verdictCounts["partial"] ?? 0} partial</Badge>
            <Badge variant="destructive">{verdictCounts["failed"] ?? 0} failed</Badge>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Failure classes</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0.5 text-xs">
            {funnel.byFailureClass.slice(0, 4).map((f) => (
              <div key={f.failureClass} className="flex justify-between">
                <span className="text-muted-foreground">{f.failureClass}</span>
                <span className="font-mono">{f.count}</span>
              </div>
            ))}
            {funnel.byFailureClass.length === 0 && (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Ratified failures</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-semibold">{funnel.totals.ratifiedFailed}</div>
          <div className="text-xs text-muted-foreground">bench-case candidates (#1106)</div>
        </CardContent>
      </Card>
    </div>
  );
}

function EvalFunnelPage() {
  const [verdict, setVerdict] = useState("failed");
  const [failureClass, setFailureClass] = useState("all");
  const [ratified, setRatified] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const { data: funnel } = useQuery({
    queryKey: ["eval", "funnel"],
    queryFn: () => apiGet<Funnel>("/eval/funnel"),
  });

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["eval", "scores", verdict, failureClass, ratified, search, page],
    queryFn: () => {
      const params = new URLSearchParams();
      if (verdict !== "all") params.set("verdict", verdict);
      if (failureClass !== "all") params.set("failureClass", failureClass);
      if (ratified !== "all") params.set("ratified", ratified);
      if (search) params.set("search", search);
      params.set("scorable", "true");
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      return apiGet<{ items: ScoreRow[]; total: number }>(`/eval/scores?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Eval Funnel</h1>
        <span className="text-sm text-muted-foreground">
          where Aura leaks value across every interaction
        </span>
      </div>

      {funnel && <FunnelCards funnel={funnel} />}

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search note or intent…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9"
          />
        </div>
        <Select value={verdict} onValueChange={(v) => { setVerdict(v); setPage(1); }}>
          <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All verdicts</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="partial">Partial</SelectItem>
            <SelectItem value="fulfilled">Fulfilled</SelectItem>
          </SelectContent>
        </Select>
        <Select value={failureClass} onValueChange={(v) => { setFailureClass(v); setPage(1); }}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All classes</SelectItem>
            <SelectItem value="missing_cred">missing_cred</SelectItem>
            <SelectItem value="bad_memory">bad_memory</SelectItem>
            <SelectItem value="bad_harness">bad_harness</SelectItem>
            <SelectItem value="missing_tool">missing_tool</SelectItem>
            <SelectItem value="reasoning">reasoning</SelectItem>
            <SelectItem value="latency">latency</SelectItem>
            <SelectItem value="none">none</SelectItem>
          </SelectContent>
        </Select>
        <Select value={ratified} onValueChange={(v) => { setRatified(v); setPage(1); }}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any ratification</SelectItem>
            <SelectItem value="true">Ratified</SelectItem>
            <SelectItem value="false">Unratified</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className={cn("flex-1 min-h-0 flex flex-col transition-opacity", isFetching && !isLoading && "opacity-50")}>
        <div className="flex-1 min-h-0 rounded-xl border overflow-auto">
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[90px]">Verdict</TableHead>
                <TableHead className="w-[120px]">Failure</TableHead>
                <TableHead>Response</TableHead>
                <TableHead className="w-[160px]">Intent</TableHead>
                <TableHead className="w-[120px]">User</TableHead>
                <TableHead className="w-[80px]">Ratified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRowsSkeleton columns={6} />
              ) : (
                rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Badge variant={VERDICT_VARIANT[r.verdict ?? ""] ?? "secondary"}>
                        {r.verdict ?? "—"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.failureClass !== "none" ? r.failureClass : "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.traceId ? (
                        <Link
                          to="/conversations/$id"
                          params={{ id: r.traceId }}
                          className="hover:underline"
                        >
                          {truncate(r.responseText ?? r.note ?? "(no text)", 90)}
                        </Link>
                      ) : (
                        truncate(r.responseText ?? r.note ?? "(no text)", 90)
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.servingIntent ? truncate(r.servingIntent, 40) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.resolvedName ?? r.userId ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.ratifiedBy ? <Badge variant="default">yes</Badge> : "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
              {!isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No scored responses found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <Pagination total={total} pageSize={PAGE_SIZE} page={page} onPageChange={setPage} />
    </div>
  );
}

export const Route = createFileRoute("/eval/")({
  component: EvalFunnelPage,
});
