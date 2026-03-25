import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/page-skeleton";

function OverviewPage() {
  return <PageSkeleton title="Overview" />;
}

export const Route = createFileRoute("/_authenticated/")({
  component: OverviewPage,
});
