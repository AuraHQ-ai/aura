import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { Sidebar } from "@/components/sidebar";
import { MobileNav } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/lib/auth";
import { LogOut } from "lucide-react";

const PUBLIC_ROUTES = ["/login", "/unauthorized"];

function RootLayout() {
  const { session, loading, logout } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const isPublicRoute = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!session && !isPublicRoute) {
    window.location.href = `/api/dashboard/auth/login?returnTo=${encodeURIComponent(pathname)}&origin=${encodeURIComponent(window.location.origin)}`;
    return null;
  }

  if (isPublicRoute) {
    return <Outlet />;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 overflow-hidden flex flex-col">
        <header className="flex h-12 items-center justify-between border-b px-4">
          <div className="flex items-center gap-2">
            <MobileNav />
            <h2 className="text-[13px] font-medium text-muted-foreground hidden md:block">
              Administration
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            {session && (
              <div className="flex items-center gap-2">
                {session.picture && (
                  <img
                    src={session.picture}
                    alt={session.name}
                    className="h-6 w-6 rounded-full"
                    referrerPolicy="no-referrer"
                  />
                )}
                <span className="text-[13px] hidden sm:inline">
                  {session.name}
                </span>
                <button
                  onClick={logout}
                  className="p-1 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground transition-colors"
                  title="Sign out"
                >
                  <LogOut className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="px-4 py-3 md:px-5 md:py-4">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
