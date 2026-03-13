"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { X, Send, Square, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { StreamingMarkdown } from "./streaming-markdown";
import type { UIMessage } from "ai";

interface ChatPanelProps {
  onClose: () => void;
}

export function ChatPanel({ onClose }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    [],
  );

  const { messages, sendMessage, status, error, stop, setMessages } = useChat({
    transport,
  });

  const isStreaming = status === "streaming";
  const isLoading = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 120) + "px";
    }
  }, [input]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage({ text: input.trim() });
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !isLoading) {
        sendMessage({ text: input.trim() });
        setInput("");
      }
    }
  }

  return (
    <div className="flex h-full flex-col border-l bg-background">
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b px-3">
        <span className="text-[13px] font-medium">Chat with Aura</span>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
            >
              Clear
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-[13px] text-muted-foreground text-center leading-relaxed">
              Ask Aura anything about<br />your data, notes, or memories.
            </p>
          </div>
        )}
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            isStreaming={isStreaming && message.id === messages[messages.length - 1]?.id}
          />
        ))}
        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {error.message || "Something went wrong"}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Aura..."
            rows={1}
            className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-[13px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {isLoading ? (
            <button
              type="button"
              onClick={stop}
              className="shrink-0 rounded-md bg-destructive p-2 text-destructive-foreground hover:bg-destructive/90 transition-colors cursor-pointer"
              title="Stop"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="shrink-0 rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              title="Send"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function MessageBubble({
  message,
  isStreaming,
}: {
  message: UIMessage;
  isStreaming: boolean;
}) {
  if (message.role === "user") {
    const text = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");

    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-[13px] text-primary-foreground">
          {text}
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div className="space-y-1">
        {message.parts.map((part, i) => {
          if (part.type === "text" && part.text) {
            return (
              <div key={i} className="text-[13px]">
                <StreamingMarkdown>{part.text}</StreamingMarkdown>
              </div>
            );
          }

          if (part.type === "reasoning") {
            return <ReasoningBlock key={i} text={part.text} isStreaming={isStreaming && part.state === "streaming"} />;
          }

          if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
            const toolName = part.type === "dynamic-tool"
              ? (part as { toolName?: string }).toolName ?? "tool"
              : part.type.replace("tool-", "");
            const state = (part as { state?: string }).state ?? "pending";

            return (
              <ToolBadge key={i} name={toolName} state={state} />
            );
          }

          return null;
        })}
        {isStreaming && !message.parts.some((p) => p.type === "text" && p.text) && (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="text-[12px]">Thinking...</span>
          </div>
        )}
      </div>
    );
  }

  return null;
}

function ReasoningBlock({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  const [open, setOpen] = useState(isStreaming);

  useEffect(() => {
    if (isStreaming) setOpen(true);
  }, [isStreaming]);

  return (
    <div className="text-[12px]">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span className="italic">Reasoning</span>
        {isStreaming && <Loader2 className="h-2.5 w-2.5 animate-spin ml-1" />}
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-border pl-2 text-muted-foreground">
          <StreamingMarkdown>{text}</StreamingMarkdown>
        </div>
      )}
    </div>
  );
}

function ToolBadge({ name, state }: { name: string; state: string }) {
  const label = name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
        state === "result"
          ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400"
          : state === "error"
            ? "border-destructive/30 bg-destructive/10 text-destructive"
            : "border-border bg-muted text-muted-foreground",
      )}
    >
      {(state === "call" || state === "partial-call") && (
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
      )}
      {state === "result" && (
        <svg className="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none">
          <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {label}
    </div>
  );
}
