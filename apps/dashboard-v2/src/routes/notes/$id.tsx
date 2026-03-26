import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DetailSkeleton } from "@/components/page-skeleton";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

interface NoteDetail {
  id: string;
  title: string;
  category: string;
  content: string;
  injectInContext: boolean;
  createdAt: string;
  updatedAt: string;
}

function NoteDetailPage() {
  const { id } = Route.useParams();
  const { data: note, isLoading, error } = useQuery({
    queryKey: ["notes", id],
    queryFn: () => apiGet<NoteDetail>(`/notes/${id}`),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load note: {error.message}</div>;
  if (!note) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/notes">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">{note.title}</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <span className="text-sm text-muted-foreground">Category</span>
            <div><Badge variant="secondary">{note.category}</Badge></div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Injected in context</span>
            <div>{note.injectInContext ? "Yes" : "No"}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Created</span>
            <div>{formatDate(note.createdAt)}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Updated</span>
            <div>{formatDate(note.updatedAt)}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Content</span>
            <div className="mt-1 whitespace-pre-wrap text-sm bg-muted rounded-md p-3">{note.content}</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/notes/$id")({
  component: NoteDetailPage,
});
