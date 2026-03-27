import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface RouteTab {
  to: string;
  label: string;
  icon?: ReactNode;
}

export function RouteTabs({ tabs }: { tabs: RouteTab[] }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="inline-flex w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground h-9">
      {tabs.map((tab) => {
        const isActive = pathname.replace(/\/$/, "") === tab.to.replace(/\/$/, "");
        return (
          <Link
            key={tab.to}
            to={tab.to}
            className={cn(
              "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-all [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
              isActive
                ? "bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30"
                : "text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground",
            )}
          >
            {tab.icon}
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
