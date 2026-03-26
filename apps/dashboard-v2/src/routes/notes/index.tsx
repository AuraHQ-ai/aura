import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/page-skeleton";
import { formatDate, truncate } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { useState } from "react";

interface Note {
  id: string;
  title: string;
  category: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

function NotesPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["notes", search],
    queryFn: () => apiGet<{ items: Note[]; total: number }>(`/notes?search=${encodeURIComponent(search)}`),
  });

  if (isLoading) return <TableSkeleton columns={4} />;
  if (error) return <div className="text-destructive text-sm">Failed to load notes: {error.message}</div>;

  const notes = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Notes</h1>
        <span className="text-sm text-muted-foreground">{data?.total ?? 0} total</span>
      </div>
      <Input
        placeholder="Search notes..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />
      <div className="rounded-xl border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Content</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {notes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">No notes found</TableCell>
              </TableRow>
            ) : (
              notes.map((note) => (
                <TableRow key={note.id}>
                  <TableCell>
                    <Link to="/notes/$id" params={{ id: note.id }} className="font-medium hover:underline">
                      {truncate(note.title, 50)}
                    </Link>
                  </TableCell>
                  <TableCell><Badge variant="secondary">{note.category}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{truncate(note.content, 60)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(note.updatedAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/notes/")({
  component: NotesPage,
});
