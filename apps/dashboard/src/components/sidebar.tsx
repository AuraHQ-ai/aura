"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  StickyNote,
  Brain,
  Users,
  CalendarClock,
  AlertTriangle,
  FileText,
  Settings,
  KeyRound,
  BarChart3,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";

const navItems = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/notes", label: "Notes", icon: StickyNote },
  { href: "/memories", label: "Memories", icon: Brain },
  { href: "/users", label: "Users", icon: Users },
  { href: "/jobs", label: "Jobs", icon: CalendarClock },
  { href: "/errors", label: "Errors", icon: AlertTriangle },
  { href: "/resources", label: "Resources", icon: FileText },
  { href: "/consumption", label: "Consumption", icon: BarChart3 },
  { href: "/credentials", label: "Credentials", icon: KeyRound },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavContent({ onClose }: { onClose?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center border-b px-3">
        <Link href="/" className="flex items-center gap-2 font-semibold text-sm" onClick={onClose}>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="14" viewBox="0 0 102 90" fill="none">
            <path fill="currentColor" d="m58 0 44 77-8 13H7L0 77 43 0h15ZM6 77l3 5 36-64 9 16 17 30h6L45 8 6 77Zm79-8H34l-3 5h64L55 5h-6l36 64Zm-48-5h28L51 39 37 64Z" />
          </svg>
          Aura Dashboard
        </Link>
      </div>
      <nav className="flex-1 space-y-0.5 px-2 py-2">
        {navItems.map((item) => {
          const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                isActive
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <item.icon className="h-3.5 w-3.5 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden md:flex md:flex-col w-[200px] shrink-0 border-r" style={{ background: "var(--sidebar-bg)" }}>
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
            <NavContent onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
