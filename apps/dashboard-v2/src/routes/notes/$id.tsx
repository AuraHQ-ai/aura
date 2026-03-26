import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPatch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DetailSkeleton } from "@/components/page-skeleton";
import { MarkdownContent } from "@/components/ui/markdown";
import { formatDate } from "@/lib/utils";
import { useState } from "react";
import { ArrowLeft, Save, Pencil, X } from "lucide-react";

interface NoteDetail {
  id: string;
  topic: string;
  category: string;
  content: string;
  injectInContext: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

function NoteDetailPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: note, isLoading, error } = useQuery({
    queryKey: ["notes", id],
    queryFn: () => apiGet<NoteDetail>(`/notes/${id}`),
  });

  const [editing, setEditing] = useState(false);
  const [topic, setTopic] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("");

  const updateMutation = useMutation({
    mutationFn: (data: { topic?: string; content?: string; category?: string }) =>
      apiPatch(`/notes/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      setEditing(false);
    },
  });

  function startEditing() {
    if (!note) return;
    setTopic(note.topic);
    setContent(note.content);
    setCategory(note.category);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
  }

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load note: {error.message}</div>;
  if (!note) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/notes"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div className="flex-1">
          {editing ? (
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="text-lg font-semibold border-0 px-0 focus-visible:ring-0 shadow-none"
            />
          ) : (
            <h1 className="text-lg font-semibold">{note.topic}</h1>
          )}
        </div>
        <Badge variant="secondary">{editing ? category : note.category}</Badge>
        {editing ? (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={cancelEditing}>
              <X className="h-4 w-4" /> Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => updateMutation.mutate({ topic, content, category })}
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

      {editing && (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-sm font-medium text-muted-foreground mb-2 block">Category</label>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
        </div>
      )}

      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span>Injected in context: {note.injectInContext ? "Yes" : "No"}</span>
        <span>Created: {formatDate(note.createdAt)}</span>
        <span>Updated: {formatDate(note.updatedAt)}</span>
        {note.expiresAt && <span>Expires: {formatDate(note.expiresAt)}</span>}
      </div>

      <div>
        {editing ? (
          <>
            <label className="text-sm font-medium text-muted-foreground mb-2 block">Content</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="flex min-h-[calc(100vh-280px)] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono"
            />
          </>
        ) : (
          <MarkdownContent content={note.content} className="max-w-3xl" />
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/notes/$id")({
  component: NoteDetailPage,
});
