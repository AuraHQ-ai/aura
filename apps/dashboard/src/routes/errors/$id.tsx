import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailSkeleton } from "@/components/page-skeleton";
import { formatDate } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";

interface ErrorDetail {
  id: string;
  errorName: string;
  errorCode: string | null;
  errorMessage: string;
  stackTrace: string | null;
  timestamp: string;
  resolved: boolean;
  context: Record<string, unknown> | null;
  userId: string | null;
  channelId: string | null;
  channelType: string | null;
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
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/errors"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div>
          <h1 className="text-base font-semibold">{err.errorName}</h1>
          <p className="text-sm text-muted-foreground">{formatDate(err.timestamp)}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {err.errorCode && <Badge variant="outline">{err.errorCode}</Badge>}
          <Badge variant={err.resolved ? "success" : "destructive"}>
            {err.resolved ? "Resolved" : "Open"}
          </Badge>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Error Message</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm">{err.errorMessage}</p>
        </CardContent>
      </Card>

      {err.stackTrace && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Stack Trace</CardTitle></CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-xs font-mono bg-muted rounded-md p-3 overflow-auto max-h-[400px]">
              {err.stackTrace}
            </pre>
          </CardContent>
        </Card>
      )}

      {err.context && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Context</CardTitle></CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-xs font-mono bg-muted rounded-md p-3 overflow-auto max-h-[400px]">
              {JSON.stringify(err.context, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {err.userId && (
          <Card>
            <CardHeader><CardTitle className="text-sm">User</CardTitle></CardHeader>
            <CardContent>
              <Link to="/users/$slackUserId" params={{ slackUserId: err.userId }} className="font-mono text-sm hover:underline">
                {err.userId}
              </Link>
            </CardContent>
          </Card>
        )}
        {err.channelId && (
          <Card>
            <CardHeader><CardTitle className="text-sm">Channel</CardTitle></CardHeader>
            <CardContent><span className="font-mono text-sm">{err.channelId}</span></CardContent>
          </Card>
        )}
        {err.channelType && (
          <Card>
            <CardHeader><CardTitle className="text-sm">Channel Type</CardTitle></CardHeader>
            <CardContent><Badge variant="outline">{err.channelType}</Badge></CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/errors/$id")({
  component: ErrorDetailPage,
});
