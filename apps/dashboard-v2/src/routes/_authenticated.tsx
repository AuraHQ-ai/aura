import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { Sidebar } from "@/components/sidebar";
import { DashboardShell } from "@/components/dashboard-shell";
import { useAuth } from "@/providers/auth-provider";
import { useEffect } from "react";

function AuthenticatedLayout() {
  const { session, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && !session) {
      navigate({ to: "/login", search: { token: undefined } });
    }
  }, [isLoading, session, navigate]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-pulse text-muted-foreground text-sm">
          Loading…
        </div>
      </div>
    );
  }

  if (!session) return null;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <DashboardShell>
        <Outlet />
      </DashboardShell>
    </div>
  );
}

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});
