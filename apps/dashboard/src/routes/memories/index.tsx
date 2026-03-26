import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { apiGet, apiDelete } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TableRowsSkeleton } from "@/components/page-skeleton";
import { Pagination } from "@/components/pagination";
import { cn, formatDate, truncate } from "@/lib/utils";
import { useState } from "react";
import { Search, Trash2 } from "lucide-react";

interface Memory {
  id: string;
  content: string;
  type: string;
  relevanceScore: number;
  shareable: number;
  createdAt: string;
}

const PAGE_SIZE = 100;
const MEMORY_TYPES = ["fact", "decision", "personal", "relationship", "sentiment", "open_thread"] as const;

function MemoriesPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [page, setPage] = useState(1);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["memories", search, typeFilter, page],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (typeFilter) params.set("type", typeFilter);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      return apiGet<{ items: Memory[]; total: number }>(`/memories?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/memories/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memories"] });
      setDeleteId(null);
    },
  });

  if (error && !data) return <div className="text-destructive text-sm">Failed to load memories: {error.message}</div>;

  const memories = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Memories</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "…" : `${total} total`}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <form onSubmit={(e) => { e.preventDefault(); setPage(1); }} className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Full-text search (press Enter)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </form>
        <select
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
          className="h-8 rounded-md border border-input bg-transparent px-2.5 text-[13px]"
        >
          <option value="">All types</option>
          {MEMORY_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      <div className={cn("flex-1 min-h-0 rounded-xl border overflow-auto transition-opacity", isFetching && !isLoading && "opacity-50")}>
        <Table className="min-w-[600px]">
          <TableHeader>
            <TableRow>
              <TableHead>Content</TableHead>
              <TableHead className="w-[90px]">Type</TableHead>
              <TableHead className="w-[80px]">Relevance</TableHead>
              <TableHead className="w-[80px]">Shareable</TableHead>
              <TableHead className="w-[160px]">Created</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRowsSkeleton columns={6} />
            ) : memories.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No memories found</TableCell>
              </TableRow>
            ) : (
              memories.map((memory) => (
                <TableRow key={memory.id}>
                  <TableCell>
                    <Link to="/memories/$id" params={{ id: memory.id }} className="hover:underline">
                      {truncate(memory.content, 80)}
                    </Link>
                  </TableCell>
                  <TableCell><Badge variant="secondary">{memory.type}</Badge></TableCell>
                  <TableCell>{memory.relevanceScore?.toFixed(2) ?? "—"}</TableCell>
                  <TableCell>{memory.shareable ? "Yes" : "No"}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{formatDate(memory.createdAt)}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon-sm" onClick={() => setDeleteId(memory.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination total={total} pageSize={PAGE_SIZE} page={page} onPageChange={setPage} />

      <Dialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Memory</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const Route = createFileRoute("/memories/")({
  component: MemoriesPage,
});
