import { useMemo, useCallback, useState, useEffect, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage, DynamicToolUIPart, ToolUIPart } from "ai";
import {
  X,
  Plus,
  Clock,
  ArrowUpIcon,
  SquareIcon,
  PaperclipIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputActionAddAttachments,
  PromptInputActionAddScreenshot,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Attachments,
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
} from "@/components/ai-elements/attachments";
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input";
import { Spinner } from "@/components/ui/spinner";

interface ModelOption {
  value: string;
  label: string;
}

interface ModelGroup {
  label: string;
  models: ModelOption[];
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
};

function buildModelGroups(main: ModelOption[], fast: ModelOption[]): ModelGroup[] {
  const allModels = [...main, ...fast];
  const seen = new Set<string>();
  const groups: Record<string, ModelOption[]> = {};

  for (const m of allModels) {
    if (seen.has(m.value)) continue;
    seen.add(m.value);
    const provider = m.value.split("/")[0];
    const groupLabel = PROVIDER_LABELS[provider] ?? provider;
    (groups[groupLabel] ??= []).push(m);
  }

  return Object.entries(groups).map(([label, models]) => ({ label, models }));
}

const DEFAULT_MODEL = "anthropic/claude-opus-4-6";

function getModelLabel(groups: ModelGroup[], value: string): string {
  for (const group of groups) {
    const found = group.models.find((m) => m.value === value);
    if (found) return found.label;
  }
  return value;
}

interface ChatThread {
  threadId: string;
  preview: string | null;
  lastActivityAt: string;
  messageCount: number;
}

interface ChatPanelProps {
  onClose: () => void;
  userId?: string;
}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("aura_session");
  if (token) return { Authorization: `Bearer ${token}` };
  return {};
}

export function ChatPanel({ onClose, userId }: ChatPanelProps) {
  const [currentThreadId, setCurrentThreadId] = useState<string>(() => crypto.randomUUID());
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);
  const threadIdRef = useRef(currentThreadId);
  threadIdRef.current = currentThreadId;
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/dashboard/chat",
        headers: () => getAuthHeaders(),
        body: () => ({ threadId: threadIdRef.current, userId, modelId: selectedModelRef.current }),
      }),
    [userId],
  );

  const { messages, sendMessage, status, error, stop, setMessages } = useChat({
    transport,
  });

  const isStreaming = status === "streaming";
  const isEmpty = messages.length === 0 && !loadingThread;

  useEffect(() => {
    fetch("/api/dashboard/chat/models", { headers: getAuthHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setModelGroups(buildModelGroups(data.main ?? [], data.fast ?? []));
      })
      .catch(() => {});
  }, []);

  const fetchThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/chat/threads", { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        setThreads(data.threads ?? []);
      }
    } catch {
      // silently ignore
    }
  }, []);

  useEffect(() => {
    fetchThreads();
  }, [fetchThreads]);

  useEffect(() => {
    if (status === "ready" && messages.length > 0) {
      fetchThreads();
    }
  }, [status, messages.length, fetchThreads]);

  const handleSubmit = useCallback(
    (msg: PromptInputMessage) => {
      if (!msg.text.trim()) return;
      setShowHistory(false);
      sendMessage({ text: msg.text.trim(), files: msg.files });
    },
    [sendMessage],
  );

  const handleNewChat = useCallback(() => {
    const newId = crypto.randomUUID();
    setCurrentThreadId(newId);
    setMessages([]);
    setShowHistory(false);
  }, [setMessages]);

  const handleSelectThread = useCallback(
    async (threadId: string) => {
      if (threadId === currentThreadId) {
        setShowHistory(false);
        return;
      }

      setLoadingThread(true);
      setShowHistory(false);
      setCurrentThreadId(threadId);
      setMessages([]);

      try {
        const res = await fetch(
          `/api/dashboard/chat/threads/${encodeURIComponent(threadId)}/messages`,
          { headers: getAuthHeaders() },
        );
        if (res.ok) {
          const data = await res.json();
          setMessages(data.messages ?? []);
        }
      } catch {
        // silently ignore
      } finally {
        setLoadingThread(false);
      }
    },
    [currentThreadId, setMessages],
  );

  return (
    <div className="flex h-full flex-col border-l bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <span className="text-[13px] font-medium">Chat with Aura</span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleNewChat}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
            title="New chat"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setShowHistory((v) => !v)}
            className={cn(
              "rounded-md p-1 transition-colors cursor-pointer",
              showHistory
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            title="Chat history"
          >
            <Clock className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {showHistory ? (
        <ThreadList
          threads={threads}
          currentThreadId={currentThreadId}
          onSelect={handleSelectThread}
          onNewChat={handleNewChat}
        />
      ) : isEmpty ? (
        <EmptyState onSubmit={handleSubmit} status={status} onStop={stop} selectedModel={selectedModel} onModelChange={setSelectedModel} modelGroups={modelGroups} />
      ) : (
        <>
          <Conversation className="flex-1">
            <ConversationContent className="gap-4 px-3 py-3">
              {loadingThread && (
                <div className="flex h-full items-center justify-center">
                  <Spinner />
                </div>
              )}
              {messages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  isStreaming={
                    isStreaming &&
                    message.id === messages[messages.length - 1]?.id
                  }
                />
              ))}
              {error && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                  {error.message || "Something went wrong"}
                </div>
              )}
              {status === "submitted" && (
                <Message from="assistant">
                  <MessageContent>
                    <Shimmer>Thinking...</Shimmer>
                  </MessageContent>
                </Message>
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          <ChatInput onSubmit={handleSubmit} status={status} onStop={stop} selectedModel={selectedModel} onModelChange={setSelectedModel} modelGroups={modelGroups} />
        </>
      )}
    </div>
  );
}

function EmptyState({
  onSubmit,
  status,
  onStop,
  selectedModel,
  onModelChange,
  modelGroups,
}: {
  onSubmit: (msg: PromptInputMessage) => void;
  status: ReturnType<typeof useChat>["status"];
  onStop: () => void;
  selectedModel: string;
  onModelChange: (value: string) => void;
  modelGroups: ModelGroup[];
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center">
      <p className="mb-4 text-[13px] text-muted-foreground text-center leading-relaxed">
        Ask Aura anything about
        <br />
        your data, notes, or memories.
      </p>
      <div className="w-full">
        <ChatInput onSubmit={onSubmit} status={status} onStop={onStop} selectedModel={selectedModel} onModelChange={onModelChange} modelGroups={modelGroups} />
      </div>
    </div>
  );
}

function ChatInput({
  onSubmit,
  status,
  onStop,
  selectedModel,
  onModelChange,
  modelGroups,
}: {
  onSubmit: (msg: PromptInputMessage) => void;
  status: ReturnType<typeof useChat>["status"];
  onStop: () => void;
  selectedModel: string;
  onModelChange: (value: string) => void;
  modelGroups: ModelGroup[];
}) {
  return (
    <div className="px-2 pb-1.5">
      <PromptInput onSubmit={onSubmit} accept="image/*">
        <AttachmentStrip />
        <PromptInputTextarea
          placeholder="Message Aura..."
          className="min-h-8 text-[13px] px-2.5 py-2"
        />
        <PromptInputFooter className="justify-between px-1.5 pb-1 pt-0">
          <div className="flex items-center gap-1">
            <ModelSelector value={selectedModel} onChange={onModelChange} groups={modelGroups} />
            <PromptInputTools>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger>
                  <PaperclipIcon className="size-3.5" />
                </PromptInputActionMenuTrigger>
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments />
                  <PromptInputActionAddScreenshot />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
            </PromptInputTools>
          </div>
          <SubmitButton status={status} onStop={onStop} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

function SubmitButton({
  status,
  onStop,
}: {
  status: ReturnType<typeof useChat>["status"];
  onStop: () => void;
}) {
  const isGenerating = status === "submitted" || status === "streaming";

  let Icon = <ArrowUpIcon className="size-4" />;
  if (status === "submitted") {
    Icon = <Spinner />;
  } else if (status === "streaming") {
    Icon = <SquareIcon className="size-2.5" />;
  }

  return (
    <PromptInputButton
      type={isGenerating ? "button" : "submit"}
      variant="default"
      size="icon-sm"
      className="rounded-full !size-7 !min-h-0 !min-w-0 !p-0"
      aria-label={isGenerating ? "Stop" : "Send"}
      onClick={
        isGenerating
          ? (e) => {
              e.preventDefault();
              onStop();
            }
          : undefined
      }
    >
      {Icon}
    </PromptInputButton>
  );
}

function AttachmentStrip() {
  try {
    const { files, remove } = usePromptInputAttachments();
    if (files.length === 0) return null;

    return (
      <div className="px-2 pt-1">
        <Attachments variant="inline">
          {files.map((file) => (
            <Attachment
              key={file.id}
              data={file}
              onRemove={() => remove(file.id)}
            >
              <AttachmentPreview />
              <AttachmentRemove />
            </Attachment>
          ))}
        </Attachments>
      </div>
    );
  } catch {
    return null;
  }
}

function ThreadList({
  threads,
  currentThreadId,
  onSelect,
  onNewChat,
}: {
  threads: ChatThread[];
  currentThreadId: string;
  onSelect: (threadId: string) => void;
  onNewChat: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <button
        onClick={onNewChat}
        className="flex items-center gap-2 border-b px-3 py-2.5 text-[13px] text-muted-foreground hover:bg-muted transition-colors cursor-pointer"
      >
        <Plus className="h-3.5 w-3.5" />
        New chat
      </button>
      {threads.length === 0 && (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[12px] text-muted-foreground">No past chats</p>
        </div>
      )}
      {threads.map((thread) => (
        <button
          key={thread.threadId}
          onClick={() => onSelect(thread.threadId)}
          className={cn(
            "flex flex-col gap-0.5 border-b px-3 py-2.5 text-left transition-colors cursor-pointer",
            thread.threadId === currentThreadId
              ? "bg-muted"
              : "hover:bg-muted/50",
          )}
        >
          <span className="text-[13px] truncate">
            {thread.preview || "Empty chat"}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {formatRelativeTime(thread.lastActivityAt)}
            {thread.messageCount > 1 &&
              ` · ${thread.messageCount} exchanges`}
          </span>
        </button>
      ))}
    </div>
  );
}

function MessageItem({
  message,
  isStreaming,
}: {
  message: UIMessage;
  isStreaming: boolean;
}) {
  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, i) => {
          switch (part.type) {
            case "text":
              if (!part.text) return null;
              return (
                <div key={i} style={{ fontSize: 13 }} className="[&_*]:![font-size:inherit] [&_h1]:![font-size:15px] [&_h2]:![font-size:14px] [&_h3]:![font-size:13px]">
                  <MessageResponse>
                    {part.text}
                  </MessageResponse>
                </div>
              );

            case "reasoning":
              return (
                <Reasoning
                  key={i}
                  isStreaming={isStreaming && part.state === "streaming"}
                >
                  <ReasoningTrigger />
                  <ReasoningContent>{part.text}</ReasoningContent>
                </Reasoning>
              );

            case "source-document":
              return null;

            case "dynamic-tool": {
              const dynPart = part as DynamicToolUIPart;
              return (
                <Tool key={i} className="mb-1 rounded-sm border-muted">
                  <ToolHeader
                    type={dynPart.type}
                    state={dynPart.state}
                    toolName={dynPart.toolName}
                    title={formatToolName(dynPart.toolName)}
                    className="px-2 py-1.5 gap-2"
                  />
                  <ToolContent className="max-h-60 overflow-y-auto px-2 py-1.5 space-y-1.5">
                    <ToolInput input={dynPart.input} />
                    {dynPart.output !== undefined && (
                      <ToolOutput
                        output={dynPart.output}
                        errorText={dynPart.errorText}
                      />
                    )}
                  </ToolContent>
                </Tool>
              );
            }

            default: {
              if (part.type.startsWith("tool-")) {
                const toolPart = part as ToolUIPart;
                const toolName = toolPart.type.replace(/^tool-/, "");
                return (
                  <Tool key={i} className="mb-1 rounded-sm border-muted">
                    <ToolHeader
                      type={toolPart.type}
                      state={toolPart.state}
                      title={formatToolName(toolName)}
                      className="px-2 py-1.5 gap-2"
                    />
                    <ToolContent className="max-h-60 overflow-y-auto px-2 py-1.5 space-y-1.5">
                      <ToolInput input={toolPart.input} />
                      {toolPart.output !== undefined && (
                        <ToolOutput
                          output={toolPart.output}
                          errorText={toolPart.errorText}
                        />
                      )}
                    </ToolContent>
                  </Tool>
                );
              }
              return null;
            }
          }
        })}
      </MessageContent>
    </Message>
  );
}

function ModelSelector({
  value,
  onChange,
  groups,
}: {
  value: string;
  onChange: (value: string) => void;
  groups: ModelGroup[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-6 gap-1 border-none bg-transparent px-1 text-[11px] text-muted-foreground shadow-none hover:text-foreground focus-visible:ring-0">
        <SelectValue>{getModelLabel(groups, value)}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start" side="top">
        {groups.map((group, gi) => (
          <SelectGroup key={group.label}>
            {gi > 0 && <SelectSeparator />}
            <SelectLabel>{group.label}</SelectLabel>
            {group.models.map((model) => (
              <SelectItem key={model.value} value={model.value} className="text-[13px]">
                {model.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function formatToolName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}
