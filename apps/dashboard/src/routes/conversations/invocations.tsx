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

interface ConversationRow {
  id: string;
  sourceType: string;
  sourceLabel: string;
  modelId: string | null;
  tokenUsage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;
  costUsd: string | null;
  messageCount: number;
  createdAt: string;
  channelId: string | null;
  userId: string | null;
  resolvedName: string | null;
  messagePreview: string | null;
}

const PAGE_SIZE = 25;

function formatPreview(name: string | null, preview: string | null): string {
  const displayName = name ?? "Unknown";
  if (!preview) return displayName;
  const truncated = truncate(preview, 50);
  return `${displayName} · "${truncated}"`;
}

function InvocationsPage() {
  const [search, setSearch] = useState("");
  const [sourceType, setSourceType] = useState("all");
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["conversations", "invocations", search, sourceType, page],
    queryFn: () => {
      const params = new URLSearchParams();
      if (sourceType !== "all") params.set("sourceType", sourceType);
      if (search) params.set("search", search);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      return apiGet<{ items: ConversationRow[]; total: number }>(`/conversations?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  if (error && !data)
    return (
      <div className="text-destructive text-sm">
        Failed to load conversations: {error.message}
      </div>
    );

  const conversations = data?.items ?? [];
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
          <Table className="min-w-[850px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[160px]">Timestamp</TableHead>
                <TableHead className="w-[80px]">Source</TableHead>
                <TableHead>Preview</TableHead>
                <TableHead className="w-[160px]">Model</TableHead>
                <TableHead className="w-[90px]">Cost</TableHead>
                <TableHead className="w-[140px]">Tokens</TableHead>
                <TableHead className="w-[60px]">Steps</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRowsSkeleton columns={7} />
              ) : conversations.map((conv) => (
                <TableRow key={conv.id}>
                  <TableCell className="text-sm text-muted-foreground">
                    <Link
                      to="/conversations/$id"
                      params={{ id: conv.id }}
                      className="hover:underline"
                    >
                      {formatDate(conv.createdAt)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        conv.sourceType === "interactive" ? "default" : "secondary"
                      }
                    >
                      {conv.sourceType === "job_execution" ? "job" : "interactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {conv.sourceType === "job_execution"
                      ? conv.sourceLabel
                      : formatPreview(conv.resolvedName, conv.messagePreview)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground font-mono">
                    {conv.modelId ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground font-mono">
                    {conv.costUsd
                      ? `$${parseFloat(conv.costUsd).toFixed(4)}`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {conv.tokenUsage
                      ? `${(conv.tokenUsage.inputTokens ?? 0).toLocaleString()} / ${(conv.tokenUsage.outputTokens ?? 0).toLocaleString()}`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {conv.messageCount}
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && conversations.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-muted-foreground py-8"
                  >
                    No conversations found
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

export const Route = createFileRoute("/conversations/invocations")({
  component: InvocationsPage,
});
