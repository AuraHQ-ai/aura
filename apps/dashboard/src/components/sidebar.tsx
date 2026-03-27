import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import {
  StickyNote,
  Brain,
  Users,
  CalendarClock,
  MessageSquare,
  AlertTriangle,
  FileText,
  Settings,
  KeyRound,
  BarChart3,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const AuraLogo = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 102 90" fill="none" className={className}>
    <path fill="currentColor" d="m58 0 44 77-8 13H7L0 77 43 0h15ZM6 77l3 5 36-64 9 16 17 30h6L45 8 6 77Zm79-8H34l-3 5h64L55 5h-6l36 64Zm-48-5h28L51 39 37 64Z" />
  </svg>
);

const navItems = [
  { href: "/", label: "Overview", icon: AuraLogo },
  { href: "/notes", label: "Notes", icon: StickyNote },
  { href: "/memories", label: "Memories", icon: Brain },
  { href: "/users", label: "Users", icon: Users },
  { href: "/jobs", label: "Jobs", icon: CalendarClock },
  { href: "/conversations", label: "Conversations", icon: MessageSquare },
  { href: "/errors", label: "Errors", icon: AlertTriangle },
  { href: "/resources", label: "Resources", icon: FileText },
  { href: "/consumption", label: "Consumption", icon: BarChart3 },
  { href: "/credentials", label: "Credentials", icon: KeyRound },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

function NavContent({ onClose, showLabels }: { onClose?: () => void; showLabels?: boolean }) {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;

  return (
    <TooltipProvider delayDuration={150}>
      <nav className={cn("flex h-full flex-col py-2 gap-0.5", showLabels ? "px-2" : "items-center")}>
        {navItems.map((item) => {
          const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const link = (
            <Link
              to={item.href}
              onClick={onClose}
              className={cn(
                "flex items-center rounded-lg transition-colors",
                showLabels
                  ? "gap-2 px-2 py-1.5 text-[13px]"
                  : "justify-center w-12 h-12",
                isActive
                  ? "bg-foreground/15 text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <item.icon className="h-[24px] w-[24px] shrink-0" strokeWidth="1.75" />
              {showLabels && item.label}
            </Link>
          );

          if (showLabels) {
            return <div key={item.href}>{link}</div>;
          }

          return (
            <Tooltip key={item.href}>
              <TooltipTrigger asChild>
                {link}
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={6}>
                {item.label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </nav>
    </TooltipProvider>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden md:flex md:flex-col w-[52px] shrink-0 border-r items-center" style={{ background: "var(--sidebar-bg)" }}>
      <NavContent />
    </aside>
  );
}

export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="md:hidden p-2 hover:bg-muted rounded-md"
        onClick={() => setOpen(true)}
      >
        <Menu className="h-5 w-5" />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="fixed inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="fixed inset-y-0 left-0 w-[200px] border-r bg-background shadow-lg">
            <div className="absolute right-2 top-3">
              <button className="p-1 hover:bg-muted rounded-md" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="pt-8">
              <NavContent onClose={() => setOpen(false)} showLabels />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
