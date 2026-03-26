import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailSkeleton } from "@/components/page-skeleton";
import { formatDate, truncate } from "@/lib/utils";
import {
  ArrowLeft,
  Clock,
  DollarSign,
  MessageSquare,
  Users,
} from "lucide-react";
import { ConversationDetailView } from "./$id";

interface Participant {
  userId: string;
  displayName: string | null;
}

interface ThreadMeta {
  channelId: string;
  totalCost: number;
  traceCount: number;
  startedAt: string;
  endedAt: string;
  participants: Participant[];
  messagePreview: string | null;
}

interface ThreadData {
  conversations: any[];
  meta: ThreadMeta;
}

function ThreadDetailPage() {
  const { channelId, threadTs } = Route.useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["conversations", "threads", channelId, threadTs],
    queryFn: () =>
      apiGet<ThreadData>(
        `/conversations/threads/${encodeURIComponent(channelId)}/${encodeURIComponent(threadTs)}`,
      ),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error)
    return (
      <div className="text-destructive text-sm">
        Failed to load thread: {error.message}
      </div>
    );
  if (!data) return null;

  const { conversations, meta } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/conversations">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">Thread Detail</h1>
          <p className="text-xs text-muted-foreground truncate">
            {meta.channelId}
            {meta.messagePreview
              ? ` · "${truncate(meta.messagePreview, 80)}"`
              : ""}
          </p>
        </div>
      </div>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <DollarSign className="h-3.5 w-3.5" />
              Total Cost
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm font-mono">
              {meta.totalCost > 0 ? `$${meta.totalCost.toFixed(4)}` : "—"}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <MessageSquare className="h-3.5 w-3.5" />
              Invocations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm">{meta.traceCount}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              Time Range
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm space-y-0.5">
              <div>{formatDate(meta.startedAt)}</div>
              {meta.traceCount > 1 && (
                <div className="text-muted-foreground">
                  → {formatDate(meta.endedAt)}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />
              Participants
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1">
              {meta.participants.length > 0 ? (
                meta.participants.map((p) => (
                  <Badge
                    key={p.userId}
                    variant="secondary"
                    className="text-xs"
                  >
                    {p.displayName ?? p.userId}
                  </Badge>
                ))
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-8">
        {conversations.map((conv: any, i: number) => (
          <div key={conv.trace.id}>
            {i > 0 && <div className="border-t border-border mb-8" />}
            <div className="space-y-4">
              <ConversationDetailView data={conv} embedded />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export const Route = createFileRoute(
  "/conversations/threads/$channelId/$threadTs",
)({
  component: ThreadDetailPage,
});
