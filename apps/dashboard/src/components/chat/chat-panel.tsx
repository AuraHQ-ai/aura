import { useMemo, useCallback, useState, useEffect, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@workflow/ai";
import type { UIMessage, DynamicToolUIPart, ToolUIPart } from "ai";
import {
  X,
  Plus,
  Clock,
  ArrowUpIcon,
  SquareIcon,
  PaperclipIcon,
  Copy,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ModelAutocomplete,
  type ModelAutocompleteOption,
} from "@/components/model-autocomplete";
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

interface ModelCatalogResponse {
  main: ModelOption[];
  fast: ModelOption[];
  catalog?: Array<{
    value: string;
    provider: string;
  }>;
  defaults?: {
    main?: string;
  };
}

interface ChatThread {
  threadId: string;
  preview: string | null;
  lastActivityAt: string;
  messageCount: number;
  /** "generating" while a workflow run is in flight for this thread (R2). */
  runStatus: "generating" | "idle";
  activeRunId: string | null;
}

interface ChatPanelProps {
  onClose: () => void;
  userId?: string;
  userName?: string;
}

interface LoadedThread {
  messages: UIMessage[];
  activeRunId: string | null;
}

const THREAD_STORAGE_KEY = "aura_chat_thread";

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("aura_session");
  if (token) return { Authorization: `Bearer ${token}` };
  return {};
}

export function ChatPanel({ onClose, userId, userName }: ChatPanelProps) {
  // Thread identity survives refresh (T3): land back in the same thread and
  // resume its stream if a run is still generating.
  const [currentThreadId, setCurrentThreadId] = useState<string>(() => {
    try {
      return localStorage.getItem(THREAD_STORAGE_KEY) || crypto.randomUUID();
    } catch {
      return crypto.randomUUID();
    }
  });
  // null = loading persisted messages for the selected thread.
  const [loadedThread, setLoadedThread] = useState<LoadedThread | null>(null);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [copied, setCopied] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelAutocompleteOption[]>([]);
  // Local run-state overlay so spinners are correct between thread refreshes.
  const [localRunState, setLocalRunState] = useState<Record<string, "generating" | "idle">>({});
  const exportRef = useRef<() => void>(() => {});

  useEffect(() => {
    try {
      localStorage.setItem(THREAD_STORAGE_KEY, currentThreadId);
    } catch {
      // ignore storage failures
    }
  }, [currentThreadId]);

  useEffect(() => {
    fetch("/api/dashboard/models", { headers: getAuthHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ModelCatalogResponse | null) => {
        if (!data) return;
        const providerByModelId = new Map(
          (data.catalog ?? []).map((model) => [model.value, model.provider]),
        );
        const options = [...(data.main ?? []), ...(data.fast ?? [])].map((model) => ({
          ...model,
          provider: providerByModelId.get(model.value),
        }));
        setModelOptions(options);
        setSelectedModel((current) => current || data.defaults?.main || options[0]?.value || "");
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

  // Keep run-status spinners live while the history panel is open or any
  // thread is generating (T1: spinner clears when generation finishes).
  const anyGenerating =
    threads.some((t) => t.runStatus === "generating") ||
    Object.values(localRunState).includes("generating");
  useEffect(() => {
    if (!showHistory && !anyGenerating) return;
    const interval = setInterval(fetchThreads, 5_000);
    return () => clearInterval(interval);
  }, [showHistory, anyGenerating, fetchThreads]);

  // Load the persisted messages (and in-flight run, if any) for the current
  // thread. Runs on mount (refresh recovery) and on every thread switch.
  useEffect(() => {
    let cancelled = false;
    setLoadedThread(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/dashboard/chat/threads/${encodeURIComponent(currentThreadId)}/messages`,
          { headers: getAuthHeaders() },
        );
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setLoadedThread({
            messages: data.messages ?? [],
            activeRunId: data.activeRunId ?? null,
          });
        } else {
          setLoadedThread({ messages: [], activeRunId: null });
        }
      } catch {
        if (!cancelled) setLoadedThread({ messages: [], activeRunId: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentThreadId]);

  const handleRunStateChange = useCallback(
    (threadId: string, state: "generating" | "idle") => {
      setLocalRunState((prev) => ({ ...prev, [threadId]: state }));
      if (state === "idle") fetchThreads();
    },
    [fetchThreads],
  );

  // R1: starting a new chat only detaches the reader (the ActiveChat below
  // unmounts). The previous thread's workflow run keeps generating
  // server-side; no abort signal ever reaches the model call.
  const handleNewChat = useCallback(() => {
    setCurrentThreadId(crypto.randomUUID());
    setShowHistory(false);
  }, []);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      setShowHistory(false);
      if (threadId === currentThreadId) return;
      setCurrentThreadId(threadId);
    },
    [currentThreadId],
  );

  const threadsWithLocalState = useMemo(
    () =>
      threads.map((t) => {
        const local = localRunState[t.threadId];
        if (local === "generating" && t.runStatus === "idle") {
          return { ...t, runStatus: "generating" as const };
        }
        return t;
      }),
    [threads, localRunState],
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
            onClick={() => exportRef.current()}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
            title={copied ? "Copied!" : "Copy chat as JSON"}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
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
          threads={threadsWithLocalState}
          currentThreadId={currentThreadId}
          onSelect={handleSelectThread}
          onNewChat={handleNewChat}
        />
      ) : loadedThread === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <ActiveChat
          // Remount per thread: detaches the previous reader without
          // cancelling its server-side run (R1/R5).
          key={currentThreadId}
          threadId={currentThreadId}
          initialMessages={loadedThread.messages}
          initialActiveRunId={loadedThread.activeRunId}
          userId={userId}
          userName={userName}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          modelOptions={modelOptions}
          onRunStateChange={handleRunStateChange}
          onCopied={() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          exportRef={exportRef}
        />
      )}
    </div>
  );
}

function ActiveChat({
  threadId,
  initialMessages,
  initialActiveRunId,
  userId,
  userName,
  selectedModel,
  onModelChange,
  modelOptions,
  onRunStateChange,
  onCopied,
  exportRef,
}: {
  threadId: string;
  initialMessages: UIMessage[];
  initialActiveRunId: string | null;
  userId?: string;
  userName?: string;
  selectedModel: string;
  onModelChange: (value: string) => void;
  modelOptions: ModelAutocompleteOption[];
  onRunStateChange: (threadId: string, state: "generating" | "idle") => void;
  onCopied: () => void;
  exportRef: React.MutableRefObject<() => void>;
}) {
  // The runId of the in-flight workflow run for this thread. Server-anchored
  // (R4): seeded from the API on mount, updated from the x-workflow-run-id
  // response header on each send.
  const activeRunIdRef = useRef<string | null>(initialActiveRunId);
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;

  const transport = useMemo(
    () =>
      new WorkflowChatTransport<UIMessage>({
        api: "/api/dashboard/chat",
        prepareSendMessagesRequest: ({ api, messages }) => ({
          api,
          headers: getAuthHeaders(),
          body: {
            messages,
            threadId,
            userId,
            userName,
            modelId: selectedModelRef.current,
          },
        }),
        onChatSendMessage: (response) => {
          const runId = response.headers.get("x-workflow-run-id");
          if (runId) {
            activeRunIdRef.current = runId;
            onRunStateChange(threadId, "generating");
          }
        },
        onChatEnd: () => {
          activeRunIdRef.current = null;
          onRunStateChange(threadId, "idle");
        },
        // R3/T3: reconnect (resume-on-mount, network drop, function timeout)
        // replays the in-flight run's stream and continues with the live tail.
        prepareReconnectToStreamRequest: ({ api: _api, ...rest }) => {
          const runId = activeRunIdRef.current;
          if (!runId) throw new Error("No active workflow run to reconnect to");
          return {
            ...rest,
            headers: getAuthHeaders(),
            api: `/api/dashboard/chat/runs/${encodeURIComponent(runId)}/stream`,
          };
        },
      }),
    [threadId, userId, userName, onRunStateChange],
  );

  const { messages, sendMessage, status, error, setMessages } = useChat({
    id: threadId,
    messages: initialMessages,
    // T2/T3: attach to the in-flight run on mount.
    resume: Boolean(initialActiveRunId),
    transport,
  });

  useEffect(() => {
    if (initialActiveRunId) onRunStateChange(threadId, "generating");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // T5: the stop button is the ONLY path that cancels generation. Detaches
  // locally AND cancels the workflow run out-of-band.
  const handleStop = useCallback(async () => {
    const runId = activeRunIdRef.current;
    if (runId) {
      try {
        await fetch(`/api/dashboard/chat/runs/${encodeURIComponent(runId)}/cancel`, {
          method: "POST",
          headers: getAuthHeaders(),
        });
      } catch {
        // best-effort cancel
      }
      activeRunIdRef.current = null;
      onRunStateChange(threadId, "idle");
    }
  }, [threadId, onRunStateChange]);

  const handleSubmit = useCallback(
    (msg: PromptInputMessage) => {
      if (!msg.text.trim()) return;
      sendMessage({ text: msg.text.trim(), files: msg.files });
    },
    [sendMessage],
  );

  useEffect(() => {
    exportRef.current = async () => {
      if (messages.length === 0) return;
      try {
        const payload = {
          threadId,
          exportedAt: new Date().toISOString(),
          messages: messages.map((m) => ({
            id: m.id,
            role: m.role,
            parts: m.parts,
            metadata: (m as { metadata?: unknown }).metadata,
          })),
        };
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        onCopied();
      } catch {
        // clipboard API may fail in insecure contexts; silently ignore
      }
    };
  }, [messages, threadId, onCopied, exportRef]);

  // Keep the local transcript tidy if the server restored nothing but the
  // stream got detached previously (no-op in the normal path).
  void setMessages;

  const isStreaming = status === "streaming";
  const isEmpty = messages.length === 0;

  if (isEmpty) {
    return (
      <EmptyState
        onSubmit={handleSubmit}
        status={status}
        onStop={handleStop}
        selectedModel={selectedModel}
        onModelChange={onModelChange}
        modelOptions={modelOptions}
      />
    );
  }

  return (
    <>
      <Conversation className="flex-1">
        <ConversationContent className="gap-4 px-3 py-3">
          {messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              isStreaming={
                isStreaming && message.id === messages[messages.length - 1]?.id
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

      <ChatInput
        onSubmit={handleSubmit}
        status={status}
        onStop={handleStop}
        selectedModel={selectedModel}
        onModelChange={onModelChange}
        modelOptions={modelOptions}
      />
    </>
  );
}

function EmptyState({
  onSubmit,
  status,
  onStop,
  selectedModel,
  onModelChange,
  modelOptions,
}: {
  onSubmit: (msg: PromptInputMessage) => void;
  status: ReturnType<typeof useChat>["status"];
  onStop: () => void;
  selectedModel: string;
  onModelChange: (value: string) => void;
  modelOptions: ModelAutocompleteOption[];
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center">
      <p className="mb-4 text-[13px] text-muted-foreground text-center leading-relaxed">
        Ask Aura anything about
        <br />
        your data, notes, or memories.
      </p>
      <div className="w-full">
        <ChatInput onSubmit={onSubmit} status={status} onStop={onStop} selectedModel={selectedModel} onModelChange={onModelChange} modelOptions={modelOptions} />
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
  modelOptions,
}: {
  onSubmit: (msg: PromptInputMessage) => void;
  status: ReturnType<typeof useChat>["status"];
  onStop: () => void;
  selectedModel: string;
  onModelChange: (value: string) => void;
  modelOptions: ModelAutocompleteOption[];
}) {
  const isGenerating = status === "submitted" || status === "streaming";

  const guardedSubmit = useCallback(
    (msg: PromptInputMessage) => {
      if (isGenerating) return;
      onSubmit(msg);
    },
    [isGenerating, onSubmit],
  );

  return (
    <div className="px-2 pb-1.5">
      <PromptInput onSubmit={guardedSubmit} accept="image/*">
        <AttachmentStrip />
        <PromptInputTextarea
          placeholder="Message Aura..."
          className="min-h-8 text-[13px] px-2.5 py-2"
        />
        <PromptInputFooter className="justify-between px-1.5 pb-1 pt-0">
          <div className="flex items-center gap-1">
            <ModelAutocomplete
              value={selectedModel}
              onValueChange={onModelChange}
              options={modelOptions}
              placeholder="Select model"
              searchPlaceholder="Search models..."
              fullWidth={false}
              triggerVariant="ghost"
              triggerClassName="h-6 gap-1 px-1 text-[11px] text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground focus-visible:ring-0"
              contentClassName="w-80 p-0"
              side="top"
            />
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
          <span className="flex items-center gap-1.5 text-[13px]">
            {thread.runStatus === "generating" && (
              <span title="Aura is generating...">
                <Spinner className="size-3 shrink-0 text-muted-foreground" />
              </span>
            )}
            <span className="truncate">{thread.preview || (thread.runStatus === "generating" ? "Generating..." : "Empty chat")}</span>
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
