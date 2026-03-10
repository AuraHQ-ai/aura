import { getMemories } from "./actions";
import { MemoriesTable } from "./memories-table";

export const dynamic = "force-dynamic";

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; type?: string }>;
}) {
  const params = await searchParams;
  const memoriesList = await getMemories(params.search, params.type);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Memories</h1>
      <MemoriesTable memories={memoriesList} />
    </div>
  );
}
