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
import { RouteTabs } from "@/components/route-tabs";
import { cn, formatDate, truncate } from "@/lib/utils";
import { useState } from "react";
import { Search, MessageSquare, Zap } from "lucide-react";

interface ThreadRow {
  channelId: string;
  threadTs: string;
  traceCount: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  firstTraceAt: string;
  lastTraceAt: string;
  userId: string | null;
  resolvedName: string | null;
  messagePreview: string | null;
  firstTraceId: string;
  sourceType: string;
}

const PAGE_SIZE = 25;

function formatPreview(name: string | null, preview: string | null): string {
  const displayName = name ?? "Unknown";
  if (!preview) return displayName;
  const truncated = truncate(preview, 50);
  return `${displayName} · "${truncated}"`;
}

function ConversationsPage() {
  const [search, setSearch] = useState("");
  const [sourceType, setSourceType] = useState("all");
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["conversations", "threads", search, sourceType, page],
    queryFn: () => {
      const params = new URLSearchParams();
      if (sourceType !== "all") params.set("sourceType", sourceType);
      if (search) params.set("search", search);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      return apiGet<{ items: ThreadRow[]; total: number }>(`/conversations/threads?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  if (error && !data)
    return (
      <div className="text-destructive text-sm">
        Failed to load conversations: {error.message}
      </div>
    );

  const threads = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Conversations</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "…" : `${total} total`}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <RouteTabs
          tabs={[
            { to: "/conversations", label: "Threads", icon: <MessageSquare /> },
            { to: "/conversations/invocations", label: "Invocations", icon: <Zap /> },
          ]}
        />
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by channel or user..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9"
          />
        </div>
        <Select
          value={sourceType}
          onValueChange={(v) => {
            setSourceType(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="interactive">Interactive</SelectItem>
            <SelectItem value="job_execution">Job execution</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className={cn("flex-1 min-h-0 flex flex-col transition-opacity", isFetching && !isLoading && "opacity-50")}>
        <div className="flex-1 min-h-0 rounded-xl border overflow-auto">
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[160px]">Started</TableHead>
                <TableHead className="w-[160px]">Last Active</TableHead>
                <TableHead className="w-[80px]">Source</TableHead>
                <TableHead>Preview</TableHead>
                <TableHead className="w-[80px]">Messages</TableHead>
                <TableHead className="w-[90px]">Cost</TableHead>
                <TableHead className="w-[140px]">Tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRowsSkeleton columns={7} />
              ) : threads.map((thread) => (
                <TableRow key={`${thread.channelId}::${thread.threadTs}`}>
                  <TableCell className="text-sm text-muted-foreground">
                    <Link
                      to="/conversations/threads/$channelId/$threadTs"
                      params={{
                        channelId: thread.channelId,
                        threadTs: thread.threadTs,
                      }}
                      search={{ highlight: undefined }}
                      className="hover:underline"
                    >
                      {formatDate(thread.firstTraceAt)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(thread.lastTraceAt)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        thread.sourceType === "interactive" ? "default" : "secondary"
                      }
                    >
                      {thread.sourceType === "job_execution" ? "job" : "interactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatPreview(thread.resolvedName, thread.messagePreview)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {thread.traceCount}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground font-mono">
                    {thread.totalCostUsd > 0
                      ? `$${thread.totalCostUsd.toFixed(4)}`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {thread.totalTokens > 0
                      ? `${thread.inputTokens.toLocaleString()} / ${thread.outputTokens.toLocaleString()}`
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && threads.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-muted-foreground py-8"
                  >
                    No threads found
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

export const Route = createFileRoute("/conversations/")({
  component: ConversationsPage,
});
