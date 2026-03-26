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
import { Input } from "@/components/ui/input";
import { TableRowsSkeleton } from "@/components/page-skeleton";
import { Pagination } from "@/components/pagination";
import { cn, formatDate } from "@/lib/utils";
import { useState } from "react";
import { Search } from "lucide-react";

interface Job {
  id: string;
  name: string;
  requestedBy: string | null;
  status: string;
  cronSchedule: string | null;
  enabled: number | boolean;
  executionCount: number;
  lastExecutedAt: string | null;
  createdAt: string;
  priority: string;
}

const PAGE_SIZE = 100;

function JobsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["jobs", search, page],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      return apiGet<{ items: Job[]; total: number }>(`/jobs?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiPatch(`/jobs/${id}`, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  if (error && !data)
    return (
      <div className="text-destructive text-sm">
        Failed to load jobs: {error.message}
      </div>
    );

  const jobs = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Jobs</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "…" : `${total} total`}
        </span>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search jobs..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="pl-9"
        />
      </div>

      <div className={cn("flex-1 min-h-0 rounded-xl border overflow-auto transition-opacity", isFetching && !isLoading && "opacity-50")}>
        <Table className="min-w-[1020px]">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-[120px]">Requested By</TableHead>
              <TableHead className="w-[80px]">Status</TableHead>
              <TableHead className="w-[120px]">Schedule</TableHead>
              <TableHead className="w-[70px]">Enabled</TableHead>
              <TableHead className="w-[90px]">Executions</TableHead>
              <TableHead className="w-[160px]">Last Run</TableHead>
              <TableHead className="w-[160px]">Created</TableHead>
              <TableHead className="w-[80px]">Priority</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRowsSkeleton columns={9} />
            ) : jobs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="text-center text-muted-foreground py-8"
                >
                  No jobs found
                </TableCell>
              </TableRow>
            ) : (
              jobs.map((job) => {
                const isEnabled = job.enabled === true || job.enabled === 1;
                return (
                  <TableRow key={job.id}>
                    <TableCell>
                      <Link
                        to="/jobs/$id"
                        params={{ id: job.id }}
                        className="font-medium hover:underline"
                      >
                        {job.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {job.requestedBy ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          job.status === "completed"
                            ? "success"
                            : job.status === "failed"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {job.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {job.cronSchedule || "—"}
                    </TableCell>
                    <TableCell>
                      <button
                        onClick={() =>
                          toggleMutation.mutate({
                            id: job.id,
                            enabled: !isEnabled,
                          })
                        }
                        disabled={toggleMutation.isPending}
                        className={`relative h-5 w-9 rounded-full transition-colors cursor-pointer ${
                          isEnabled ? "bg-emerald-500" : "bg-muted"
                        }`}
                      >
                        <span
                          className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                            isEnabled
                              ? "translate-x-4"
                              : "translate-x-0.5"
                          }`}
                        />
                      </button>
                    </TableCell>
                    <TableCell>{job.executionCount}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(job.lastExecutedAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(job.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{job.priority}</Badge>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination total={total} pageSize={PAGE_SIZE} page={page} onPageChange={setPage} />
    </div>
  );
}

export const Route = createFileRoute("/jobs/")({
  component: JobsPage,
});
