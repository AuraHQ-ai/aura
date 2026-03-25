import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/page-skeleton";

function ErrorsPage() {
  return <PageSkeleton title="Errors" />;
}

export const Route = createFileRoute("/_authenticated/errors")({
  component: ErrorsPage,
});
