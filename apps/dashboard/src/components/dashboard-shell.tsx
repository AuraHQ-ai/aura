"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  usePanelRef,
} from "react-resizable-panels";
import { LogOut, MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { MobileNav } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";
import { ChatPanel } from "./chat/chat-panel";
import type { Session } from "@/lib/auth";

interface DashboardShellProps {
  session: Session | null;
  children: React.ReactNode;
}

export function DashboardShell({ session, children }: DashboardShellProps) {
  const chatPanelRef = usePanelRef();

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "aura-dashboard-layout",
  });

  const initiallyOpen = defaultLayout ? (defaultLayout["chat"] ?? 0) > 0 : false;
  const [chatOpen, setChatOpen] = useState(initiallyOpen);

  useEffect(() => {
    if (!initiallyOpen && chatPanelRef.current) {
      chatPanelRef.current.collapse();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleChat = useCallback(() => {
    const panel = chatPanelRef.current;
    if (!panel) return;

    if (chatOpen) {
      panel.collapse();
      setChatOpen(false);
    } else {
      panel.expand();
      setChatOpen(true);
    }
  }, [chatOpen, chatPanelRef]);

  const handleChatResize = useCallback(
    (size: { asPercentage: number }) => {
      const collapsed = size.asPercentage === 0;
      setChatOpen(!collapsed);
    },
    [],
  );

  return (
    <Group
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className="flex-1 overflow-hidden"
    >
      <Panel id="content" minSize="50%">
        <div className="flex h-full flex-col overflow-hidden">
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
          <main className="flex-1 overflow-y-auto">
            <div className="px-4 py-3 md:px-5 md:py-4">{children}</div>
          </main>
        </div>
      </Panel>

      <Separator
        className={cn(
          "w-[3px] bg-border transition-colors data-[separator]:hover:bg-accent",
          !chatOpen && "hidden",
        )}
      />

      <Panel
        id="chat"
        panelRef={chatPanelRef}
        minSize="20%"
        defaultSize="30%"
        collapsible
        collapsedSize="0%"
        onResize={handleChatResize}
      >
        {chatOpen && <ChatPanel onClose={toggleChat} />}
      </Panel>
    </Group>
  );
}
