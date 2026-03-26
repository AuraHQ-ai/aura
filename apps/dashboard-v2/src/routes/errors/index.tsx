import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/page-skeleton";
import { formatDate, truncate } from "@/lib/utils";

interface ErrorEntry {
  id: string;
  errorName: string;
  errorCode: string | null;
  message: string;
  timestamp: string;
  resolved: boolean;
}

function ErrorsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["errors"],
    queryFn: () => apiGet<{ items: ErrorEntry[]; total: number }>("/errors"),
  });

  if (isLoading) return <TableSkeleton columns={5} />;
  if (error) return <div className="text-destructive text-sm">Failed to load errors: {error.message}</div>;

  const errors = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Errors</h1>
        <span className="text-sm text-muted-foreground">{data?.total ?? 0} total</span>
      </div>
      <div className="rounded-xl border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Error</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {errors.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">No errors found</TableCell>
              </TableRow>
            ) : (
              errors.map((err) => (
                <TableRow key={err.id}>
                  <TableCell>
                    <Link to="/errors/$id" params={{ id: err.id }} className="font-medium hover:underline">
                      {err.errorName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{err.errorCode ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{truncate(err.message, 50)}</TableCell>
                  <TableCell>
                    {err.resolved ? <Badge variant="success">Resolved</Badge> : <Badge variant="destructive">Open</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(err.timestamp)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/errors/")({
  component: ErrorsPage,
});
