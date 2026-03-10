"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate, truncate } from "@/lib/utils";
import { searchMemoriesKeyword, deleteMemory } from "./actions";
import { Search, Trash2 } from "lucide-react";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Memory } from "@schema";

const MEMORY_TYPES = ["fact", "decision", "personal", "relationship", "sentiment", "open_thread"] as const;

export function MemoriesTable({ memories: initialMemories }: { memories: Memory[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [memories, setMemories] = useState(initialMemories);
  const [searchMode, setSearchMode] = useState<"filter" | "keyword">("filter");
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const filtered = typeFilter
    ? memories.filter((m) => m.type === typeFilter)
    : memories;

  const display = search && searchMode === "filter"
    ? filtered.filter((m) => m.content.toLowerCase().includes(search.toLowerCase()))
    : filtered;

  async function handleKeywordSearch() {
    if (!search) {
      setMemories(initialMemories);
      return;
    }
    const results = await searchMemoriesKeyword(search);
    setMemories(results);
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
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={searchMode === "keyword" ? "Full-text search..." : "Filter memories..."}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && searchMode === "keyword" && handleKeywordSearch()}
            className="pl-9"
          />
        </div>
        <div className="flex rounded-lg border p-0.5 text-sm">
          <button
            onClick={() => setSearchMode("filter")}
            className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${searchMode === "filter" ? "bg-muted font-medium" : ""}`}
          >
            Filter
          </button>
          <button
            onClick={() => setSearchMode("keyword")}
            className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${searchMode === "keyword" ? "bg-muted font-medium" : ""}`}
          >
            Keyword
          </button>
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
        >
          <option value="">All types</option>
          {MEMORY_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Content</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Relevance</TableHead>
            <TableHead>Shareable</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {display.map((memory) => (
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
          {display.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                No memories found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

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
