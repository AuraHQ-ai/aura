import { getExecutionWithConversation } from "../../../actions";
import { notFound } from "next/navigation";
import { ExecutionDetail } from "./execution-detail";

export const dynamic = "force-dynamic";

export default async function ExecutionDetailPage({
  params,
}: {
  params: Promise<{ id: string; execId: string }>;
}) {
  const { id: jobId, execId } = await params;
  const data = await getExecutionWithConversation(execId);
  if (!data) return notFound();

  return (
    <div className="space-y-4">
      <ExecutionDetail data={data} jobId={jobId} />
    </div>
  );
}
