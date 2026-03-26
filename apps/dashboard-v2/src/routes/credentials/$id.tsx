import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DetailSkeleton } from "@/components/page-skeleton";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

interface CredentialDetail {
  id: string;
  name: string;
  type: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function CredentialDetailPage() {
  const { id } = Route.useParams();
  const { data: cred, isLoading, error } = useQuery({
    queryKey: ["credentials", id],
    queryFn: () => apiGet<CredentialDetail>(`/credentials/${id}`),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load credential: {error.message}</div>;
  if (!cred) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/credentials">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">{cred.name}</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Credential Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <span className="text-sm text-muted-foreground">Type</span>
            <div><Badge variant="secondary">{cred.type}</Badge></div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Last Used</span>
            <div>{formatDate(cred.lastUsedAt)}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Created</span>
            <div>{formatDate(cred.createdAt)}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Updated</span>
            <div>{formatDate(cred.updatedAt)}</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/credentials/$id")({
  component: CredentialDetailPage,
});
