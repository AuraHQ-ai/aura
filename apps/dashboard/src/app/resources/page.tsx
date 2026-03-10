import { getResources } from "./actions";
import { ResourcesTable } from "./resources-table";

export const dynamic = "force-dynamic";

export default async function ResourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; status?: string }>;
}) {
  const params = await searchParams;
  const resourcesList = await getResources(params.source, params.status);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Resources</h1>
      <ResourcesTable resources={resourcesList} />
    </div>
  );
}
