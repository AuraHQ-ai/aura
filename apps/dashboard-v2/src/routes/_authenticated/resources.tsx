import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/page-skeleton";

function ResourcesPage() {
  return <PageSkeleton title="Resources" />;
}

export const Route = createFileRoute("/_authenticated/resources")({
  component: ResourcesPage,
});
