import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/page-skeleton";

function UsersPage() {
  return <PageSkeleton title="Users" />;
}

export const Route = createFileRoute("/_authenticated/users")({
  component: UsersPage,
});
