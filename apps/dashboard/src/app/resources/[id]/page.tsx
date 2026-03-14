import { getResource } from "../actions";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MarkdownContent } from "@/components/ui/markdown";
import { BackButton } from "@/components/back-button";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ResourceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resource = await getResource(id);
  if (!resource) return notFound();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <BackButton />
        <div>
          <h1 className="text-base font-semibold">{resource.title || "Untitled"}</h1>
          <a href={resource.url} target="_blank" rel="noopener noreferrer" className="text-sm text-muted-foreground hover:underline">
            {resource.url}
          </a>
        </div>
        <div className="ml-auto">
          <Badge variant={
            resource.status === "ready" ? "success" :
            resource.status === "error" ? "destructive" :
            "warning"
          }>
            {resource.status}
          </Badge>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-sm">Source</CardTitle></CardHeader>
          <CardContent><Badge variant="outline">{resource.source}</Badge></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Crawled</CardTitle></CardHeader>
          <CardContent><span className="text-sm">{formatDate(resource.crawledAt)}</span></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Updated</CardTitle></CardHeader>
          <CardContent><span className="text-sm">{formatDate(resource.updatedAt)}</span></CardContent>
        </Card>
      </div>

      {resource.summary && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Summary</CardTitle></CardHeader>
          <CardContent><p className="text-sm">{resource.summary}</p></CardContent>
        </Card>
      )}

      {resource.content && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Content</CardTitle></CardHeader>
          <CardContent>
            <MarkdownContent content={resource.content} className="max-w-3xl" />
          </CardContent>
        </Card>
      )}

      {resource.errorMessage && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Error</CardTitle></CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-xs font-mono text-destructive bg-muted rounded-md p-3">
              {resource.errorMessage}
            </pre>
          </CardContent>
        </Card>
      )}

      {resource.metadata && Object.keys(resource.metadata).length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Metadata</CardTitle></CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-xs font-mono bg-muted rounded-md p-3 overflow-auto max-h-[300px]">
              {JSON.stringify(resource.metadata, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
