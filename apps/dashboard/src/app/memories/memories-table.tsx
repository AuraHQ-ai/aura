"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/pagination";
import { formatDate, truncate } from "@/lib/utils";
import { deleteMemory } from "./actions";
import { Search, Trash2 } from "lucide-react";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Memory } from "@schema";

type MemoryRow = Omit<Memory, "searchVector">;

const MEMORY_TYPES = ["fact", "decision", "personal", "relationship", "sentiment", "open_thread"] as const;

interface Props {
  memories: MemoryRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function MemoriesTable({ memories, total, page, pageSize }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState(searchParams.get("search") || "");
  const typeFilter = searchParams.get("type") || "";

  function updateParams(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    params.delete("page");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    updateParams("search", searchValue);
  }

  async function handleDelete() {
    if (!deleteId) return;
    await deleteMemory(deleteId);
    setDeleteId(null);
    router.refresh();
  }

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <form onSubmit={handleSearchSubmit} className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Full-text search (press Enter)..."
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            className="pl-9"
          />
        </form>
        <select
          value={typeFilter}
          onChange={(e) => updateParams("type", e.target.value)}
          className="h-8 rounded-md border border-input bg-transparent px-2.5 text-[13px]"
        >
          <option value="">All types</option>
          {MEMORY_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto">
        <Table className="min-w-[700px]">
          <TableHeader>
            <TableRow>
              <TableHead>Content</TableHead>
              <TableHead className="w-[90px]">Type</TableHead>
              <TableHead className="w-[80px]">Relevance</TableHead>
              <TableHead className="w-[80px]">Shareable</TableHead>
              <TableHead className="w-[140px]">Created</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {memories.map((memory) => (
              <TableRow key={memory.id}>
                <TableCell>
                  <Link href={`/memories/${memory.id}`} className="hover:underline">
                    {truncate(memory.content, 80)}
                  </Link>
                </TableCell>
                <TableCell><Badge variant="secondary">{memory.type}</Badge></TableCell>
                <TableCell>{memory.relevanceScore.toFixed(2)}</TableCell>
                <TableCell>{memory.shareable ? "Yes" : "No"}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{formatDate(memory.createdAt)}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" onClick={() => setDeleteId(memory.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {memories.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  No memories found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination total={total} pageSize={pageSize} page={page} />

      <Dialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <DialogHeader>
          <DialogTitle>Delete Memory</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground mb-4">This action cannot be undone.</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
          <Button variant="destructive" onClick={handleDelete}>Delete</Button>
        </div>
      </Dialog>
    </>
  );
}
