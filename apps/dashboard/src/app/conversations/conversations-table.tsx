"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Pagination } from "@/components/pagination";
import { formatDate } from "@/lib/utils";
import { Search } from "lucide-react";

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
}

interface Props {
  conversations: ConversationRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function ConversationsTable({ conversations, total, page, pageSize }: Props) {
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

  return (
    <>
      <div className="flex items-center gap-2">
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
          onChange={(e) => handleSourceType(e.target.value)}
          className="w-[160px]"
        >
          <option value="all">All sources</option>
          <option value="interactive">Interactive</option>
          <option value="job_execution">Job execution</option>
        </Select>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Timestamp</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Source Label</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Cost</TableHead>
            <TableHead>Tokens</TableHead>
            <TableHead>Messages</TableHead>
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
              <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                {conv.sourceLabel}
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

      <Pagination total={total} pageSize={pageSize} page={page} />
    </>
  );
}
