import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/page-skeleton";
import { formatDate } from "@/lib/utils";

interface Credential {
  id: string;
  name: string;
  type: string;
  lastUsedAt: string | null;
  createdAt: string;
}

function CredentialsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["credentials"],
    queryFn: () => apiGet<{ items: Credential[]; total: number }>("/credentials"),
  });

  if (isLoading) return <TableSkeleton columns={4} />;
  if (error) return <div className="text-destructive text-sm">Failed to load credentials: {error.message}</div>;

  const credentials = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Credentials</h1>
        <span className="text-sm text-muted-foreground">{data?.total ?? 0} total</span>
      </div>
      <div className="rounded-xl border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Last Used</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {credentials.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">No credentials found</TableCell>
              </TableRow>
            ) : (
              credentials.map((cred) => (
                <TableRow key={cred.id}>
                  <TableCell>
                    <Link to="/credentials/$id" params={{ id: cred.id }} className="font-medium hover:underline">
                      {cred.name}
                    </Link>
                  </TableCell>
                  <TableCell><Badge variant="secondary">{cred.type}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(cred.lastUsedAt)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(cred.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/credentials/")({
  component: CredentialsPage,
});
