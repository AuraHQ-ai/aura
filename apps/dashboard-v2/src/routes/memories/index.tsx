import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableSkeleton } from "@/components/page-skeleton";
import { formatDate, truncate } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { useState } from "react";

interface Memory {
  id: string;
  content: string;
  sourceType: string;
  createdAt: string;
}

function MemoriesPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["memories", search],
    queryFn: () => apiGet<{ items: Memory[]; total: number }>(`/memories?search=${encodeURIComponent(search)}`),
  });

  if (isLoading) return <TableSkeleton columns={4} />;
  if (error) return <div className="text-destructive text-sm">Failed to load memories: {error.message}</div>;

  const memories = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Memories</h1>
        <span className="text-sm text-muted-foreground">{data?.total ?? 0} total</span>
      </div>
      <Input
        placeholder="Search memories..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />
      <div className="rounded-xl border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Content</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {memories.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-muted-foreground">No memories found</TableCell>
              </TableRow>
            ) : (
              memories.map((mem) => (
                <TableRow key={mem.id}>
                  <TableCell>
                    <Link to="/memories/$id" params={{ id: mem.id }} className="hover:underline">
                      {truncate(mem.content, 80)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{mem.sourceType}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(mem.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/memories/")({
  component: MemoriesPage,
});
