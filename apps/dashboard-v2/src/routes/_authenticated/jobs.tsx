import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/page-skeleton";

function JobsPage() {
  return <PageSkeleton title="Jobs" />;
}

export const Route = createFileRoute("/_authenticated/jobs")({
  component: JobsPage,
});
