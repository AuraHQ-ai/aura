import { getErrors } from "./actions";
import { ErrorsTable } from "./errors-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function ErrorsPage({
  searchParams,
}: {
  searchParams: Promise<{ resolved?: string; search?: string; page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || "1", 10) || 1);
  const { items, total } = await getErrors(params.resolved, params.search, page, PAGE_SIZE);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Errors</h1>
      <ErrorsTable errors={items} total={total} page={page} pageSize={PAGE_SIZE} />
    </div>
  );
}
