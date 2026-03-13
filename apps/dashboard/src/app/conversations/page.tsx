import { getConversations, getThreads } from "./actions";
import { ConversationsTable } from "./conversations-table";
import type { ThreadRow } from "./actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ sourceType?: string; search?: string; page?: string; view?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const view = params.view === "invocations" ? "invocations" as const : "threads" as const;

  let conversations: Awaited<ReturnType<typeof getConversations>>["items"] = [];
  let threads: ThreadRow[] = [];
  let total = 0;

  if (view === "threads") {
    const result = await getThreads(params.sourceType, params.search, page, PAGE_SIZE);
    threads = result.items;
    total = result.total;
  } else {
    const result = await getConversations(params.sourceType, params.search, page, PAGE_SIZE);
    conversations = result.items;
    total = result.total;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Conversations</h1>
      <ConversationsTable
        conversations={conversations}
        threads={threads}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        view={view}
      />
    </div>
  );
}
