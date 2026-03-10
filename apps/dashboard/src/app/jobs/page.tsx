import { getJobs } from "./actions";
import { JobsTable } from "./jobs-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || "1", 10) || 1);
  const { items, total } = await getJobs(params.search, page, PAGE_SIZE);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Jobs</h1>
      <JobsTable jobs={items} total={total} page={page} pageSize={PAGE_SIZE} />
    </div>
  );
}
