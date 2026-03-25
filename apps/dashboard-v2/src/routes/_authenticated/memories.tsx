import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/page-skeleton";

function MemoriesPage() {
  return <PageSkeleton title="Memories" />;
}

export const Route = createFileRoute("/_authenticated/memories")({
  component: MemoriesPage,
});
