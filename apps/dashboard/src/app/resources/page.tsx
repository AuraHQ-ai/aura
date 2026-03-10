import { getResources } from "./actions";
import { ResourcesTable } from "./resources-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function ResourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; status?: string; search?: string; page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || "1", 10) || 1);
  const { items, total } = await getResources(params.source, params.status, params.search, page, PAGE_SIZE);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Resources</h1>
      <ResourcesTable resources={items} total={total} page={page} pageSize={PAGE_SIZE} />
    </div>
  );
}
