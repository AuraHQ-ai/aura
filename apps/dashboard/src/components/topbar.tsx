import { getSession } from "@/lib/auth";
import { ThemeToggle } from "./theme-toggle";
import { MobileNav } from "./sidebar";
import { LogOut } from "lucide-react";

export async function Topbar() {
  const session = await getSession();

  return (
    <header className="flex h-12 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2">
        <MobileNav />
        <h2 className="text-[13px] font-medium text-muted-foreground hidden md:block">Administration</h2>
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
            <span className="text-[13px] hidden sm:inline">{session.name}</span>
            <a
              href="/api/auth/logout"
              className="p-1 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground transition-colors"
              title="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" />
            </a>
          </div>
        )}
      </div>
    </header>
  );
}
