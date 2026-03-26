import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Sidebar, MobileNav } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { ChatPanel } from "@/components/chat/chat-panel";
import { useAuth } from "@/lib/auth";
import { LogOut, MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useCallback } from "react";

const PUBLIC_ROUTES = ["/login", "/unauthorized"];

function Header({
  session,
  chatOpen,
  toggleChat,
}: {
  session: { name: string; picture: string; slackUserId: string } | null;
  chatOpen: boolean;
  toggleChat: () => void;
}) {
  const { logout } = useAuth();

  return (
    <header className="flex h-12 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2">
        <MobileNav />
        <h2 className="text-[13px] font-medium text-muted-foreground hidden md:block">
          Administration
        </h2>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={toggleChat}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] transition-colors cursor-pointer",
            chatOpen
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
          title={chatOpen ? "Close chat" : "Open chat"}
        >
          <MessageCircle className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Chat</span>
        </button>
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
  );
}

function RootLayout() {
  const { session, loading } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isPublicRoute = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
  const [chatOpen, setChatOpen] = useState(false);

  const toggleChat = useCallback(() => {
    setChatOpen((prev) => !prev);
  }, []);

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
      <Group orientation="horizontal" className="flex-1 overflow-hidden">
        <Panel id="content" minSize="50%">
          <div className="flex h-full flex-col overflow-hidden">
            <Header session={session} chatOpen={chatOpen} toggleChat={toggleChat} />
            <main className="flex-1 overflow-y-auto">
              <div className="px-4 py-3 md:px-5 md:py-4">
                <Outlet />
              </div>
            </main>
          </div>
        </Panel>

        {chatOpen && (
          <>
            <Separator className="w-[3px] bg-border hover:bg-accent transition-colors" />
            <Panel id="chat" minSize="20%" defaultSize="30%">
              <ChatPanel onClose={toggleChat} userId={session?.slackUserId} />
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
