import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DetailSkeleton } from "@/components/page-skeleton";
import { formatDate, truncate } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";

interface LinkedMemory {
  memoryId: string;
  role: string | null;
  content: string;
  type: string;
  importance: number | null;
  relevanceScore: number;
  createdAt: string;
}

interface EntityAlias {
  id: string;
  alias: string;
  source: string | null;
}

interface EntityDetail {
  id: string;
  type: string;
  canonicalName: string;
  slackUserId: string | null;
  summary: string | null;
  summaryUpdatedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  aliases: EntityAlias[];
  linkedMemories: LinkedMemory[];
}

function EntityDetailPage() {
  const { id } = Route.useParams();
  const { data: entity, isLoading, error } = useQuery({
    queryKey: ["entities", id],
    queryFn: () => apiGet<EntityDetail>(`/entities/${id}`),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load entity: {error.message}</div>;
  if (!entity) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/memories/entities" search={{ search: undefined, type: undefined, page: undefined }}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight flex-1">{entity.canonicalName}</h1>
        <Badge variant="secondary">{entity.type}</Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">Summary</CardTitle></CardHeader>
          <CardContent>
            <span className="text-sm">{entity.summary || "No summary generated yet"}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Slack User</CardTitle></CardHeader>
          <CardContent>
            {entity.slackUserId ? (
              <Link to="/users/$slackUserId" params={{ slackUserId: entity.slackUserId }}>
                <span className="text-sm font-mono hover:underline">{entity.slackUserId}</span>
              </Link>
            ) : (
              <span className="text-sm font-mono">—</span>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Created</CardTitle></CardHeader>
          <CardContent>
            <span className="text-sm">{formatDate(entity.createdAt)}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Updated</CardTitle></CardHeader>
          <CardContent>
            <span className="text-sm">{formatDate(entity.updatedAt)}</span>
          </CardContent>
        </Card>
      </div>

      {entity.aliases.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Aliases ({entity.aliases.length})</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {entity.aliases.map((a) => (
                <Badge key={a.id} variant="outline">{a.alias}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Linked Memories ({entity.linkedMemories.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Content</TableHead>
                <TableHead className="w-[90px]">Type</TableHead>
                <TableHead className="w-[80px]">Role</TableHead>
                <TableHead className="w-[100px]">Importance</TableHead>
                <TableHead className="w-[80px]">Relevance</TableHead>
                <TableHead className="w-[160px]">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entity.linkedMemories.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No linked memories</TableCell>
                </TableRow>
              ) : (
                entity.linkedMemories.map((m) => (
                  <TableRow key={m.memoryId}>
                    <TableCell>
                      <Link to="/memories/$id" params={{ id: m.memoryId }} className="hover:underline">
                        {truncate(m.content, 80)}
                      </Link>
                    </TableCell>
                    <TableCell><Badge variant="secondary">{m.type}</Badge></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{m.role ?? "—"}</TableCell>
                    <TableCell className="text-sm font-mono">{m.importance ?? "—"}</TableCell>
                    <TableCell className="text-sm">{m.relevanceScore?.toFixed(2) ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{formatDate(m.createdAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/memories/entities_/$id")({
  component: EntityDetailPage,
});
