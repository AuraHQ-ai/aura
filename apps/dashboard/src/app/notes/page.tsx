import { getNotes } from "./actions";
import { NotesTable } from "./notes-table";

export const dynamic = "force-dynamic";

export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; category?: string }>;
}) {
  const params = await searchParams;
  const notesList = await getNotes(params.search, params.category);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Notes</h1>
      </div>
      <NotesTable notes={notesList} />
    </div>
  );
}
