import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/page-skeleton";

function NotesPage() {
  return <PageSkeleton title="Notes" />;
}

export const Route = createFileRoute("/_authenticated/notes")({
  component: NotesPage,
});
