import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/page-skeleton";

function ConversationsPage() {
  return <PageSkeleton title="Conversations" />;
}

export const Route = createFileRoute("/_authenticated/conversations")({
  component: ConversationsPage,
});
