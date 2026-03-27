import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPatch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailSkeleton } from "@/components/page-skeleton";
import { formatDate } from "@/lib/utils";
import { useState } from "react";
import { MarkdownContent } from "@/components/ui/markdown";
import { ArrowLeft, Save, Pencil, X } from "lucide-react";

interface MemoryDetail {
  id: string;
  content: string;
  type: string;
  relevanceScore: number;
  shareable: number;
  sourceType: string;
  sourceId: string | null;
  createdAt: string;
  relatedUsers: { slackUserId: string; displayName: string }[];
}

function MemoryDetailPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: memory, isLoading, error } = useQuery({
    queryKey: ["memories", id],
    queryFn: () => apiGet<MemoryDetail>(`/memories/${id}`),
  });

  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState("");
  const [relevance, setRelevance] = useState(0);
  const [shareable, setShareable] = useState(0);

  const updateMutation = useMutation({
    mutationFn: (data: { content?: string; relevanceScore?: number; shareable?: number }) =>
      apiPatch(`/memories/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memories"] });
      setEditing(false);
    },
  });

  function startEditing() {
    if (!memory) return;
    setContent(memory.content);
    setRelevance(memory.relevanceScore);
    setShareable(memory.shareable);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
  }

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load memory: {error.message}</div>;
  if (!memory) return null;

  const relatedUsers = memory.relatedUsers ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/memories" search={{ search: undefined, type: undefined, page: undefined }}><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div className="flex-1 flex items-center gap-2">
          <Badge variant="secondary">{memory.type}</Badge>
          <span className="text-sm text-muted-foreground">{formatDate(memory.createdAt)}</span>
        </div>
        {editing ? (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={cancelEditing}>
              <X className="h-4 w-4" /> Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => updateMutation.mutate({ content, relevanceScore: relevance, shareable })}
              disabled={updateMutation.isPending}
            >
              <Save className="h-4 w-4" /> {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={startEditing}>
            <Pencil className="h-4 w-4" /> Edit
          </Button>
        )}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Content</CardTitle></CardHeader>
        <CardContent>
          {editing ? (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="flex min-h-[calc(100vh-400px)] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            />
          ) : (
            <MarkdownContent content={memory.content} className="max-w-3xl" />
          )}
        </CardContent>
      </Card>

      {editing ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardHeader><CardTitle className="text-sm">Relevance Score</CardTitle></CardHeader>
            <CardContent>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={relevance}
                onChange={(e) => setRelevance(parseFloat(e.target.value))}
                className="w-full"
              />
              <span className="text-sm text-muted-foreground">{relevance.toFixed(1)}</span>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">Shareable</CardTitle></CardHeader>
            <CardContent>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={shareable === 1}
                  onChange={(e) => setShareable(e.target.checked ? 1 : 0)}
                />
                <span className="text-sm">{shareable ? "Shareable across channels" : "Private"}</span>
              </label>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">Related Users</CardTitle></CardHeader>
            <CardContent>
              {relatedUsers.length === 0 ? (
                <span className="text-sm text-muted-foreground">None</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {relatedUsers.map((u) => (
                    <Badge key={u.slackUserId} variant="outline">{u.displayName}</Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardHeader><CardTitle className="text-sm">Relevance Score</CardTitle></CardHeader>
            <CardContent>
              <span className="text-sm">{memory.relevanceScore?.toFixed(1) ?? "—"}</span>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">Shareable</CardTitle></CardHeader>
            <CardContent>
              <span className="text-sm">{memory.shareable ? "Shareable across channels" : "Private"}</span>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">Related Users</CardTitle></CardHeader>
            <CardContent>
              {relatedUsers.length === 0 ? (
                <span className="text-sm text-muted-foreground">None</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {relatedUsers.map((u) => (
                    <Badge key={u.slackUserId} variant="outline">{u.displayName}</Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/memories/$id")({
  component: MemoryDetailPage,
});
