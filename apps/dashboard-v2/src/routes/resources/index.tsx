import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/page-skeleton";
import { formatDate, truncate } from "@/lib/utils";

interface Resource {
  id: string;
  name: string;
  type: string;
  url: string | null;
  createdAt: string;
}

function ResourcesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["resources"],
    queryFn: () => apiGet<{ items: Resource[]; total: number }>("/resources"),
  });

  if (isLoading) return <TableSkeleton columns={4} />;
  if (error) return <div className="text-destructive text-sm">Failed to load resources: {error.message}</div>;

  const resources = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Resources</h1>
        <span className="text-sm text-muted-foreground">{data?.total ?? 0} total</span>
      </div>
      <div className="rounded-xl border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {resources.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">No resources found</TableCell>
              </TableRow>
            ) : (
              resources.map((res) => (
                <TableRow key={res.id}>
                  <TableCell>
                    <Link to="/resources/$id" params={{ id: res.id }} className="font-medium hover:underline">
                      {res.name}
                    </Link>
                  </TableCell>
                  <TableCell><Badge variant="secondary">{res.type}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{res.url ? truncate(res.url, 40) : "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(res.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/resources/")({
  component: ResourcesPage,
});
