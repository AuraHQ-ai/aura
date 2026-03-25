import { useState, useCallback, useEffect, type ReactNode } from "react";
import { Panel, Group } from "react-resizable-panels";
import { LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { MobileNav } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";
import { useAuth } from "@/providers/auth-provider";

function Header() {
  const { session, logout } = useAuth();

  return (
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
              className="p-1 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              title="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

interface DashboardShellProps {
  children: ReactNode;
}

export function DashboardShell({ children }: DashboardShellProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="flex-1 overflow-hidden flex">
        <div className="flex h-full w-full flex-col overflow-hidden">
          <Header />
          <main className="flex-1 overflow-y-auto">
            <div className="px-4 py-3 md:px-5 md:py-4">{children}</div>
          </main>
        </div>
      </div>
    );
  }

  return (
    <Group orientation="horizontal" className="flex-1 overflow-hidden">
      <Panel id="content" minSize="50%">
        <div className="flex h-full flex-col overflow-hidden">
          <Header />
          <main className="flex-1 overflow-y-auto">
            <div className="px-4 py-3 md:px-5 md:py-4">{children}</div>
          </main>
        </div>
      </Panel>
    </Group>
  );
}
