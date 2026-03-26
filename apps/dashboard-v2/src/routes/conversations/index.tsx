import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/page-skeleton";
import { formatDate, truncate } from "@/lib/utils";

interface Conversation {
  id: string;
  channelId: string;
  channelName: string | null;
  threadTs: string | null;
  userName: string | null;
  lastMessageAt: string;
  messageCount: number;
}

function ConversationsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => apiGet<{ items: Conversation[]; total: number }>("/conversations"),
  });

  if (isLoading) return <TableSkeleton columns={5} />;
  if (error) return <div className="text-destructive text-sm">Failed to load conversations: {error.message}</div>;

  const conversations = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Conversations</h1>
        <span className="text-sm text-muted-foreground">{data?.total ?? 0} total</span>
      </div>
      <div className="rounded-xl border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Channel</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Messages</TableHead>
              <TableHead>Last Message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {conversations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">No conversations found</TableCell>
              </TableRow>
            ) : (
              conversations.map((conv) => (
                <TableRow key={conv.id}>
                  <TableCell>
                    <Link to="/conversations/$id" params={{ id: conv.id }} className="font-medium hover:underline">
                      {conv.channelName ? truncate(conv.channelName, 30) : conv.channelId}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{conv.userName ?? "—"}</TableCell>
                  <TableCell><Badge variant="secondary">{conv.messageCount}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(conv.lastMessageAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/conversations/")({
  component: ConversationsPage,
});
