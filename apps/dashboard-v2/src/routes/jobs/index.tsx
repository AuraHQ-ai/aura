import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/page-skeleton";
import { formatDate } from "@/lib/utils";

interface Job {
  id: string;
  name: string;
  schedule: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

function JobsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => apiGet<{ items: Job[]; total: number }>("/jobs"),
  });

  if (isLoading) return <TableSkeleton columns={5} />;
  if (error) return <div className="text-destructive text-sm">Failed to load jobs: {error.message}</div>;

  const jobs = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Jobs</h1>
        <span className="text-sm text-muted-foreground">{data?.total ?? 0} total</span>
      </div>
      <div className="rounded-xl border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last Run</TableHead>
              <TableHead>Next Run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">No jobs found</TableCell>
              </TableRow>
            ) : (
              jobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>
                    <Link to="/jobs/$id" params={{ id: job.id }} className="font-medium hover:underline">
                      {job.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{job.schedule ?? "—"}</TableCell>
                  <TableCell>
                    {job.enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="outline">Disabled</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(job.lastRunAt)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(job.nextRunAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/jobs/")({
  component: JobsPage,
});
