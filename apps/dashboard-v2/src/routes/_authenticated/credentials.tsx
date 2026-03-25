import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/page-skeleton";

function CredentialsPage() {
  return <PageSkeleton title="Credentials" />;
}

export const Route = createFileRoute("/_authenticated/credentials")({
  component: CredentialsPage,
});
