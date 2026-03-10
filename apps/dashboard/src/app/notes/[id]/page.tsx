import { getNote } from "../actions";
import { notFound } from "next/navigation";
import { NoteEditor } from "./note-editor";

export const dynamic = "force-dynamic";

export default async function NoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const note = await getNote(id);
  if (!note) return notFound();

  return (
    <div className="space-y-4">
      <NoteEditor note={note} />
    </div>
  );
}
