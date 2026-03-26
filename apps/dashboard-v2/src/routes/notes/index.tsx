import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TableRowsSkeleton } from "@/components/page-skeleton";
import { Pagination } from "@/components/pagination";
import { cn, formatDate, truncate } from "@/lib/utils";
import { useState } from "react";
import { Plus, Trash2, Search } from "lucide-react";

interface Note {
  id: string;
  topic: string;
  category: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

const PAGE_SIZE = 100;

function NotesPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [newTopic, setNewTopic] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newCategory, setNewCategory] = useState("knowledge");

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["notes", search, page],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      return apiGet<{ items: Note[]; total: number }>(`/notes?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  const createMutation = useMutation({
    mutationFn: (data: { topic: string; content: string; category: string }) =>
      apiPost("/notes", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      setShowCreate(false);
      setNewTopic("");
      setNewContent("");
      setNewCategory("knowledge");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/notes/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      setDeleteId(null);
    },
  });

  if (error && !data) return <div className="text-destructive text-sm">Failed to load notes: {error.message}</div>;

  const notes = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Notes</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "…" : `${total} total`}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search notes..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9"
          />
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" /> New Note
        </Button>
      </div>

      <div className={cn("rounded-xl border overflow-hidden transition-opacity", isFetching && !isLoading && "opacity-50")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Topic</TableHead>
              <TableHead className="w-[100px]">Category</TableHead>
              <TableHead className="w-[140px]">Updated</TableHead>
              <TableHead className="w-[140px]">Expires</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRowsSkeleton columns={5} />
            ) : notes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">No notes found</TableCell>
              </TableRow>
            ) : (
              notes.map((note) => (
                <TableRow key={note.id}>
                  <TableCell>
                    <Link to="/notes/$id" params={{ id: note.id }} className="font-medium hover:underline">
                      {truncate(note.topic, 60)}
                    </Link>
                  </TableCell>
                  <TableCell><Badge variant="secondary">{note.category}</Badge></TableCell>
                  <TableCell className="text-muted-foreground text-sm">{formatDate(note.updatedAt)}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{formatDate(note.expiresAt)}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon-sm" onClick={() => setDeleteId(note.id)}>
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

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Note</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <Input placeholder="Topic" value={newTopic} onChange={(e) => setNewTopic(e.target.value)} />
            <textarea
              placeholder="Content (markdown)"
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              className="flex min-h-[200px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            />
            <Input placeholder="Category" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button
                onClick={() => createMutation.mutate({ topic: newTopic, content: newContent, category: newCategory })}
                disabled={!newTopic || !newContent || createMutation.isPending}
              >
                {createMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Note</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Are you sure you want to delete this note? This action cannot be undone.</p>
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

export const Route = createFileRoute("/notes/")({
  component: NotesPage,
});
