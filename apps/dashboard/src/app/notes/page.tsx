import { getNotes } from "./actions";
import { NotesTable } from "./notes-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; category?: string; page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || "1", 10) || 1);
  const { items, total } = await getNotes(params.search, params.category, page, PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Notes</h1>
      </div>
      <NotesTable notes={items} total={total} page={page} pageSize={PAGE_SIZE} />
    </div>
  );
}
