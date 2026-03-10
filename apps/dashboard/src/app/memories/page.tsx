import { getMemories } from "./actions";
import { MemoriesTable } from "./memories-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; type?: string; page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || "1", 10) || 1);
  const { items, total } = await getMemories(params.search, params.type, page, PAGE_SIZE);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Memories</h1>
      <MemoriesTable memories={items} total={total} page={page} pageSize={PAGE_SIZE} />
    </div>
  );
}
