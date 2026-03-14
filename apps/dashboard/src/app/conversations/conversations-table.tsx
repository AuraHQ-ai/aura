"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pagination } from "@/components/pagination";
import { formatDate, truncate } from "@/lib/utils";
import { Search } from "lucide-react";
import type { ThreadRow } from "./actions";

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
  createdAt: Date;
  channelId: string | null;
  userId: string | null;
  resolvedName: string | null;
  messagePreview: string | null;
}

type ViewMode = "threads" | "invocations";

interface Props {
  conversations: ConversationRow[];
  threads: ThreadRow[];
  total: number;
  page: number;
  pageSize: number;
  view: ViewMode;
}

function ViewSwitcher({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="inline-flex h-8 items-center justify-center rounded-md bg-muted p-0.5 text-muted-foreground">
      <button
        className={`inline-flex items-center justify-center whitespace-nowrap rounded px-2.5 py-1 text-[13px] font-medium transition-all cursor-pointer ${
          view === "threads"
            ? "bg-background text-foreground shadow"
            : "hover:text-foreground"
        }`}
        onClick={() => onChange("threads")}
      >
        Threads
      </button>
      <button
        className={`inline-flex items-center justify-center whitespace-nowrap rounded px-2.5 py-1 text-[13px] font-medium transition-all cursor-pointer ${
          view === "invocations"
            ? "bg-background text-foreground shadow"
            : "hover:text-foreground"
        }`}
        onClick={() => onChange("invocations")}
      >
        Invocations
      </button>
    </div>
  );
}

function formatPreview(name: string | null, preview: string | null): string {
  const displayName = name ?? "Unknown";
  if (!preview) return displayName;
  const truncated = truncate(preview, 50);
  return `${displayName} · "${truncated}"`;
}

function InvocationsTable({ conversations }: { conversations: ConversationRow[] }) {
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[800px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[140px]">Timestamp</TableHead>
            <TableHead className="w-[80px]">Source</TableHead>
            <TableHead>Preview</TableHead>
            <TableHead className="w-[160px]">Model</TableHead>
            <TableHead className="w-[90px]">Cost</TableHead>
            <TableHead className="w-[140px]">Tokens</TableHead>
            <TableHead className="w-[60px]">Steps</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {conversations.map((conv) => (
            <TableRow key={conv.id}>
              <TableCell className="text-sm text-muted-foreground">
                <Link href={`/conversations/${conv.id}`} className="hover:underline">
                  {formatDate(conv.createdAt)}
                </Link>
              </TableCell>
              <TableCell>
                <Badge
                  variant={conv.sourceType === "interactive" ? "default" : "secondary"}
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
                {conv.costUsd ? `$${parseFloat(conv.costUsd).toFixed(4)}` : "—"}
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
          {conversations.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                No conversations found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function ThreadsTable({ threads }: { threads: ThreadRow[] }) {
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[800px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[140px]">Started</TableHead>
            <TableHead className="w-[140px]">Last Active</TableHead>
            <TableHead className="w-[80px]">Source</TableHead>
            <TableHead>Preview</TableHead>
            <TableHead className="w-[80px]">Messages</TableHead>
            <TableHead className="w-[90px]">Cost</TableHead>
            <TableHead className="w-[140px]">Tokens</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {threads.map((thread) => (
            <TableRow key={`${thread.channelId}::${thread.threadTs}`}>
              <TableCell className="text-sm text-muted-foreground">
                <Link href={`/conversations/threads/${thread.channelId}/${thread.threadTs}`} className="hover:underline">
                  {formatDate(thread.firstTraceAt)}
                </Link>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDate(thread.lastTraceAt)}
              </TableCell>
              <TableCell>
                <Badge
                  variant={thread.sourceType === "interactive" ? "default" : "secondary"}
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
                {thread.totalCostUsd > 0 ? `$${thread.totalCostUsd.toFixed(4)}` : "—"}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {thread.totalTokens > 0
                  ? `${thread.inputTokens.toLocaleString()} / ${thread.outputTokens.toLocaleString()}`
                  : "—"}
              </TableCell>
            </TableRow>
          ))}
          {threads.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                No threads found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export function ConversationsTable({ conversations, threads, total, page, pageSize, view }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [searchValue, setSearchValue] = useState(searchParams.get("search") || "");

  function updateParams(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
    }
    params.delete("page");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function handleSearch(value: string) {
    setSearchValue(value);
    updateParams({ search: value || null });
  }

  function handleSourceType(value: string) {
    updateParams({ sourceType: value === "all" ? null : value });
  }

  function handleViewChange(newView: ViewMode) {
    updateParams({ view: newView === "threads" ? null : newView });
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <ViewSwitcher view={view} onChange={handleViewChange} />
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by channel or user..."
            value={searchValue}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select
          value={searchParams.get("sourceType") || "all"}
          onValueChange={(v) => handleSourceType(v)}
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

      {view === "threads" ? (
        <ThreadsTable threads={threads} />
      ) : (
        <InvocationsTable conversations={conversations} />
      )}

      <Pagination total={total} pageSize={pageSize} page={page} />
    </>
  );
}
