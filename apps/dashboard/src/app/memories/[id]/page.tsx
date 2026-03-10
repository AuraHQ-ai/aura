import { getMemory } from "../actions";
import { notFound } from "next/navigation";
import { MemoryDetail } from "./memory-detail";

export const dynamic = "force-dynamic";

export default async function MemoryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const memory = await getMemory(id);
  if (!memory) return notFound();

  return (
    <div className="space-y-4">
      <MemoryDetail memory={memory} />
    </div>
  );
}
