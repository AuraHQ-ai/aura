import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/page-skeleton";

function ConsumptionPage() {
  return <PageSkeleton title="Consumption" />;
}

export const Route = createFileRoute("/_authenticated/consumption")({
  component: ConsumptionPage,
});
