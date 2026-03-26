import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DetailSkeleton } from "@/components/page-skeleton";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

interface ResourceDetail {
  id: string;
  name: string;
  type: string;
  url: string | null;
  content: string | null;
  createdAt: string;
  updatedAt: string;
}

function ResourceDetailPage() {
  const { id } = Route.useParams();
  const { data: resource, isLoading, error } = useQuery({
    queryKey: ["resources", id],
    queryFn: () => apiGet<ResourceDetail>(`/resources/${id}`),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load resource: {error.message}</div>;
  if (!resource) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/resources">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">{resource.name}</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Resource Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <span className="text-sm text-muted-foreground">Type</span>
            <div><Badge variant="secondary">{resource.type}</Badge></div>
          </div>
          {resource.url && (
            <div>
              <span className="text-sm text-muted-foreground">URL</span>
              <div>
                <a href={resource.url} target="_blank" rel="noopener noreferrer" className="text-sm hover:underline text-primary">
                  {resource.url}
                </a>
              </div>
            </div>
          )}
          <div>
            <span className="text-sm text-muted-foreground">Created</span>
            <div>{formatDate(resource.createdAt)}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Updated</span>
            <div>{formatDate(resource.updatedAt)}</div>
          </div>
          {resource.content && (
            <div>
              <span className="text-sm text-muted-foreground">Content</span>
              <div className="mt-1 whitespace-pre-wrap text-sm bg-muted rounded-md p-3">{resource.content}</div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/resources/$id")({
  component: ResourceDetailPage,
});
