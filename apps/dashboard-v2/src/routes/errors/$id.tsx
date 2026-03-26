import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DetailSkeleton } from "@/components/page-skeleton";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

interface ErrorDetail {
  id: string;
  errorName: string;
  errorCode: string | null;
  message: string;
  stack: string | null;
  timestamp: string;
  resolved: boolean;
  context: Record<string, unknown> | null;
}

function ErrorDetailPage() {
  const { id } = Route.useParams();
  const { data: err, isLoading, error } = useQuery({
    queryKey: ["errors", id],
    queryFn: () => apiGet<ErrorDetail>(`/errors/${id}`),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load error: {error.message}</div>;
  if (!err) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/errors">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">{err.errorName}</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Error Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {err.errorCode && (
            <div>
              <span className="text-sm text-muted-foreground">Error Code</span>
              <div><Badge variant="outline">{err.errorCode}</Badge></div>
            </div>
          )}
          <div>
            <span className="text-sm text-muted-foreground">Status</span>
            <div>{err.resolved ? <Badge variant="success">Resolved</Badge> : <Badge variant="destructive">Open</Badge>}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Timestamp</span>
            <div>{formatDate(err.timestamp)}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Message</span>
            <div className="mt-1 text-sm bg-muted rounded-md p-3">{err.message}</div>
          </div>
          {err.stack && (
            <div>
              <span className="text-sm text-muted-foreground">Stack Trace</span>
              <pre className="mt-1 text-xs bg-muted rounded-md p-3 overflow-x-auto whitespace-pre-wrap">{err.stack}</pre>
            </div>
          )}
          {err.context && (
            <div>
              <span className="text-sm text-muted-foreground">Context</span>
              <pre className="mt-1 text-xs bg-muted rounded-md p-3 overflow-x-auto">{JSON.stringify(err.context, null, 2)}</pre>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/errors/$id")({
  component: ErrorDetailPage,
});
