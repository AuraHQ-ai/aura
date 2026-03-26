import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DetailSkeleton } from "@/components/page-skeleton";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

interface ThreadDetail {
  channelId: string;
  threadTs: string;
  channelName: string | null;
  messages: Array<{
    role: string;
    content: string;
    timestamp: string;
    userName: string | null;
  }>;
}

function ThreadDetailPage() {
  const { channelId, threadTs } = Route.useParams();
  const { data: thread, isLoading, error } = useQuery({
    queryKey: ["conversations", "threads", channelId, threadTs],
    queryFn: () => apiGet<ThreadDetail>(`/conversations/threads/${channelId}/${threadTs}`),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load thread: {error.message}</div>;
  if (!thread) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/conversations">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">
          Thread in {thread.channelName ?? thread.channelId}
        </h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Thread Messages</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {thread.messages.map((msg, i) => (
            <div key={i} className="border-b last:border-0 pb-3 last:pb-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium">{msg.userName ?? msg.role}</span>
                <span className="text-xs text-muted-foreground">{formatDate(msg.timestamp)}</span>
              </div>
              <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/conversations/threads/$channelId/$threadTs")({
  component: ThreadDetailPage,
});
