import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { apiGet, apiPatch } from "@/lib/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { cn, formatDate, truncate } from "@/lib/utils";
import { useState } from "react";
import { Search, CheckCircle } from "lucide-react";

interface ErrorEntry {
  id: string;
  errorName: string;
  errorCode: string | null;
  errorMessage: string;
  timestamp: string;
  resolved: boolean;
}

const PAGE_SIZE = 100;

function ErrorsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [resolvedFilter, setResolvedFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["errors", search, resolvedFilter, page],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (resolvedFilter !== "all") params.set("resolved", resolvedFilter);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      return apiGet<{ items: ErrorEntry[]; total: number }>(
        `/errors?${params}`,
      );
    },
    placeholderData: keepPreviousData,
  });

  const resolveMutation = useMutation({
    mutationFn: (ids: string[]) => apiPatch("/errors", { ids }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["errors"] });
      setSelected(new Set());
    },
  });

  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  if (error && !data)
    return (
      <div className="text-destructive text-sm">
        Failed to load errors: {error.message}
      </div>
    );

  const errors = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Errors</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "…" : `${total} total`}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search errors..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9"
          />
        </div>
        <Select
          value={resolvedFilter}
          onValueChange={(v) => {
            setResolvedFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="false">Open</SelectItem>
            <SelectItem value="true">Resolved</SelectItem>
          </SelectContent>
        </Select>
        {selected.size > 0 && (
          <Button
            size="sm"
            onClick={() => resolveMutation.mutate(Array.from(selected))}
            disabled={resolveMutation.isPending}
          >
            <CheckCircle className="h-4 w-4" /> Resolve ({selected.size})
          </Button>
        )}
      </div>

      <div className={cn("rounded-xl border overflow-hidden transition-opacity", isFetching && !isLoading && "opacity-50")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead className="w-[180px]">Error</TableHead>
              <TableHead className="w-[80px]">Code</TableHead>
              <TableHead>Message</TableHead>
              <TableHead className="w-[80px]">Status</TableHead>
              <TableHead className="w-[140px]">Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRowsSkeleton columns={6} />
            ) : errors.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground py-8"
                >
                  No errors found
                </TableCell>
              </TableRow>
            ) : (
              errors.map((err) => (
                <TableRow key={err.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selected.has(err.id)}
                      onChange={() => toggleSelect(err.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <Link
                      to="/errors/$id"
                      params={{ id: err.id }}
                      className="font-medium hover:underline"
                    >
                      {err.errorName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {err.errorCode ? (
                      <Badge variant="outline">{err.errorCode}</Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {truncate(err.errorMessage, 80)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={err.resolved ? "success" : "destructive"}
                    >
                      {err.resolved ? "Resolved" : "Open"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDate(err.timestamp)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination total={total} pageSize={PAGE_SIZE} page={page} onPageChange={setPage} />
    </div>
  );
}

export const Route = createFileRoute("/errors/")({
  component: ErrorsPage,
});
