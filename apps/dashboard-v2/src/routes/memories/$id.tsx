import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DetailSkeleton } from "@/components/page-skeleton";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

interface MemoryDetail {
  id: string;
  content: string;
  sourceType: string;
  sourceId: string | null;
  createdAt: string;
}

function MemoryDetailPage() {
  const { id } = Route.useParams();
  const { data: memory, isLoading, error } = useQuery({
    queryKey: ["memories", id],
    queryFn: () => apiGet<MemoryDetail>(`/memories/${id}`),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load memory: {error.message}</div>;
  if (!memory) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/memories">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Memory Detail</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <span className="text-sm text-muted-foreground">Source Type</span>
            <div>{memory.sourceType}</div>
          </div>
          {memory.sourceId && (
            <div>
              <span className="text-sm text-muted-foreground">Source ID</span>
              <div className="font-mono text-sm">{memory.sourceId}</div>
            </div>
          )}
          <div>
            <span className="text-sm text-muted-foreground">Created</span>
            <div>{formatDate(memory.createdAt)}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Content</span>
            <div className="mt-1 whitespace-pre-wrap text-sm bg-muted rounded-md p-3">{memory.content}</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/memories/$id")({
  component: MemoryDetailPage,
});
