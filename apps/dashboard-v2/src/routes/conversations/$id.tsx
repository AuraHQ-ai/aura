import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DetailSkeleton } from "@/components/page-skeleton";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

interface ConversationDetail {
  id: string;
  channelId: string;
  channelName: string | null;
  threadTs: string | null;
  userName: string | null;
  lastMessageAt: string;
  messageCount: number;
  messages: Array<{
    role: string;
    content: string;
    timestamp: string;
  }>;
}

function ConversationDetailPage() {
  const { id } = Route.useParams();
  const { data: conv, isLoading, error } = useQuery({
    queryKey: ["conversations", id],
    queryFn: () => apiGet<ConversationDetail>(`/conversations/${id}`),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load conversation: {error.message}</div>;
  if (!conv) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/conversations">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">
          {conv.channelName ?? conv.channelId}
        </h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Conversation Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <span className="text-sm text-muted-foreground">Channel</span>
            <div>{conv.channelName ?? conv.channelId}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">User</span>
            <div>{conv.userName ?? "—"}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Messages</span>
            <div>{conv.messageCount}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Last Message</span>
            <div>{formatDate(conv.lastMessageAt)}</div>
          </div>
        </CardContent>
      </Card>
      {conv.messages && conv.messages.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Messages</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {conv.messages.map((msg, i) => (
              <div key={i} className="border-b last:border-0 pb-3 last:pb-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium">{msg.role}</span>
                  <span className="text-xs text-muted-foreground">{formatDate(msg.timestamp)}</span>
                </div>
                <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export const Route = createFileRoute("/conversations/$id")({
  component: ConversationDetailPage,
});
