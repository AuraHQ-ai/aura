import { getErrors } from "./actions";
import { ErrorsTable } from "./errors-table";

export const dynamic = "force-dynamic";

export default async function ErrorsPage({
  searchParams,
}: {
  searchParams: Promise<{ resolved?: string }>;
}) {
  const params = await searchParams;
  const errors = await getErrors(params.resolved);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Errors</h1>
      <ErrorsTable errors={errors} />
    </div>
  );
}
