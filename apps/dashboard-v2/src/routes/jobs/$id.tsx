import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DetailSkeleton } from "@/components/page-skeleton";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

interface JobDetail {
  id: string;
  name: string;
  description: string | null;
  schedule: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

function JobDetailPage() {
  const { id } = Route.useParams();
  const { data: job, isLoading, error } = useQuery({
    queryKey: ["jobs", id],
    queryFn: () => apiGet<JobDetail>(`/jobs/${id}`),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load job: {error.message}</div>;
  if (!job) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/jobs">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">{job.name}</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Job Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {job.description && (
            <div>
              <span className="text-sm text-muted-foreground">Description</span>
              <div>{job.description}</div>
            </div>
          )}
          <div>
            <span className="text-sm text-muted-foreground">Schedule</span>
            <div className="font-mono text-sm">{job.schedule ?? "None"}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Status</span>
            <div>{job.enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="outline">Disabled</Badge>}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Last Run</span>
            <div>{formatDate(job.lastRunAt)}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Next Run</span>
            <div>{formatDate(job.nextRunAt)}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Created</span>
            <div>{formatDate(job.createdAt)}</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/jobs/$id")({
  component: JobDetailPage,
});
