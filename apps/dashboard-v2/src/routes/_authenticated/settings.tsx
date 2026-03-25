import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/page-skeleton";

function SettingsPage() {
  return <PageSkeleton title="Settings" />;
}

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});
