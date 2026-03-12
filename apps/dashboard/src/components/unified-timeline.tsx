"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { ConversationMessage as ConversationMessageRow, ConversationPart } from "@schema";
import { MarkdownContent } from "@/components/ui/markdown";

export type ConversationMessageWithParts = ConversationMessageRow & { parts: ConversationPart[] };

function Collapsible({
  title,
  defaultOpen = false,
  badge,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border rounded-md">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-muted/50 cursor-pointer"
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="flex-1">{title}</span>
        {badge}
      </button>
      {open && <div className="border-t px-3 py-2">{children}</div>}
    </div>
  );
}

function ToolInvocationBlock({ part }: { part: ConversationPart }) {
  const [showInput, setShowInput] = useState(false);
  const [showOutput, setShowOutput] = useState(false);

  const inputStr =
    part.toolInput != null
      ? typeof part.toolInput === "string"
        ? part.toolInput
        : JSON.stringify(part.toolInput, null, 2)
      : null;

  const outputStr =
    part.toolOutput != null
      ? typeof part.toolOutput === "string"
        ? part.toolOutput
        : JSON.stringify(part.toolOutput, null, 2)
      : null;

  return (
    <div className="border rounded-md bg-muted/30">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Badge variant="outline" className="text-[11px] font-mono">
          {part.toolName}
        </Badge>
        {part.toolCallId && (
          <span className="text-[10px] text-muted-foreground font-mono">
            {part.toolCallId.slice(0, 12)}...
          </span>
        )}
        <Badge
          variant={part.toolState === "result" ? "success" : "secondary"}
          className="text-[10px] ml-auto"
        >
          {part.toolState}
        </Badge>
      </div>

      {inputStr && (
        <div className="border-t">
          <button
            className="flex w-full items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={() => setShowInput(!showInput)}
          >
            {showInput ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Input
            <span className="text-[10px]">
              ({inputStr.length.toLocaleString()} chars)
            </span>
          </button>
          {showInput && (
            <pre className="px-3 pb-2 text-xs font-mono whitespace-pre-wrap overflow-auto max-h-[400px]">
              {inputStr}
            </pre>
          )}
        </div>
      )}

      {outputStr && (
        <div className="border-t">
          <button
            className="flex w-full items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={() => setShowOutput(!showOutput)}
          >
            {showOutput ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Output
            <span className="text-[10px]">
              ({outputStr.length.toLocaleString()} chars)
            </span>
          </button>
          {showOutput && (
            <pre className="px-3 pb-2 text-xs font-mono whitespace-pre-wrap overflow-auto max-h-[400px]">
              {outputStr}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

const SYSTEM_PREVIEW_LENGTH = 200;
const LONG_TEXT_THRESHOLD = 1000;

function SystemMessageBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<"markdown" | "raw">("markdown");
  const isLong = text.length > SYSTEM_PREVIEW_LENGTH;
  const preview = isLong ? text.slice(0, SYSTEM_PREVIEW_LENGTH) + "..." : text;

  return (
    <div className="border rounded-md bg-muted/20">
      <div className="flex items-center gap-2 px-3 py-2">
        <Badge variant="secondary" className="text-[10px]">system</Badge>
        <span className="text-xs text-muted-foreground">
          {text.length.toLocaleString()} chars
        </span>
        <div className="flex items-center gap-1 ml-auto">
          <button
            className={`text-xs px-2 py-0.5 rounded ${viewMode === "raw" ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setViewMode("raw")}
          >
            Raw
          </button>
          <button
            className={`text-xs px-2 py-0.5 rounded ${viewMode === "markdown" ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setViewMode("markdown")}
          >
            Markdown
          </button>
        </div>
      </div>
      <div className="border-t px-3 py-2">
        {viewMode === "raw" ? (
          <pre className="whitespace-pre-wrap text-xs font-mono overflow-auto max-h-[600px]">
            {expanded ? text : preview}
          </pre>
        ) : (
          <MarkdownContent
            content={expanded ? text : preview}
            className="max-w-none overflow-auto max-h-[600px] text-xs"
          />
        )}
        {isLong && (
          <button
            className="mt-1 text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Collapse" : "Expand full prompt"}
          </button>
        )}
      </div>
    </div>
  );
}

function UserMessageBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(text.length <= LONG_TEXT_THRESHOLD);
  const isLong = text.length > LONG_TEXT_THRESHOLD;

  return (
    <div className="border rounded-md bg-blue-50/50 dark:bg-blue-950/20">
      <div className="flex items-center gap-2 px-3 py-2">
        <Badge variant="default" className="text-[10px]">user</Badge>
        <span className="text-xs text-muted-foreground">
          {text.length.toLocaleString()} chars
        </span>
      </div>
      <div className="border-t px-3 py-2">
        {expanded ? (
          <pre className="whitespace-pre-wrap text-xs font-mono overflow-auto max-h-[600px]">
            {text}
          </pre>
        ) : (
          <pre className="whitespace-pre-wrap text-xs font-mono overflow-auto">
            {text.slice(0, SYSTEM_PREVIEW_LENGTH) + "..."}
          </pre>
        )}
        {isLong && (
          <button
            className="mt-1 text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Collapse" : "Expand full message"}
          </button>
        )}
      </div>
    </div>
  );
}

function AssistantStepBlock({ msg, stepIndex }: { msg: ConversationMessageWithParts; stepIndex: number }) {
  const stepTokenUsage = msg.tokenUsage as {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
    outputTokenDetails?: { reasoningTokens?: number };
  } | null;

  return (
    <div className="border rounded-md">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
        <Badge variant="secondary" className="text-[10px]">
          Step {stepIndex}
        </Badge>
        <Badge variant="outline" className="text-[10px]">assistant</Badge>
        {msg.modelId && (
          <span className="text-[10px] text-muted-foreground font-mono">
            {msg.modelId}
          </span>
        )}
        <span className="text-xs text-muted-foreground ml-auto flex items-center gap-2">
          {stepTokenUsage && (
            <span className="font-mono text-[10px]">
              {(stepTokenUsage.inputTokens ?? 0).toLocaleString()} in / {(stepTokenUsage.outputTokens ?? 0).toLocaleString()} out
              {stepTokenUsage.outputTokenDetails?.reasoningTokens
                ? ` (${stepTokenUsage.outputTokenDetails.reasoningTokens.toLocaleString()} reasoning)`
                : ""}
            </span>
          )}
          {formatDate(msg.createdAt)}
        </span>
      </div>
      <div className="border-t px-3 py-2 space-y-2">
        {msg.parts
          .filter((p) => p.type !== "step-start")
          .map((part) => {
            if (part.type === "reasoning") {
              return (
                <Collapsible
                  key={part.id}
                  title="Reasoning"
                  badge={
                    <Badge variant="warning" className="text-[10px]">
                      reasoning
                    </Badge>
                  }
                >
                  <pre className="whitespace-pre-wrap text-xs font-mono italic overflow-auto max-h-[400px] text-muted-foreground">
                    {part.textValue}
                  </pre>
                </Collapsible>
              );
            }

            if (part.type === "tool-invocation") {
              return <ToolInvocationBlock key={part.id} part={part} />;
            }

            if (part.type === "error" && part.textValue) {
              return (
                <div
                  key={part.id}
                  className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="destructive" className="text-[10px]">
                      error
                    </Badge>
                  </div>
                  <pre className="whitespace-pre-wrap font-mono text-xs text-destructive overflow-auto max-h-[400px]">
                    {part.textValue}
                  </pre>
                </div>
              );
            }

            if (part.type === "text" && part.textValue) {
              return (
                <div
                  key={part.id}
                  className="text-sm bg-muted/30 rounded-md px-3 py-2 border"
                >
                  <pre className="whitespace-pre-wrap font-mono text-xs overflow-auto max-h-[400px]">
                    {part.textValue}
                  </pre>
                </div>
              );
            }

            return null;
          })}
      </div>
    </div>
  );
}

export function UnifiedTimeline({
  conversation,
  rawJson,
}: {
  conversation: ConversationMessageWithParts[];
  rawJson?: unknown;
}) {
  const [showRaw, setShowRaw] = useState(false);

  const sorted = [...conversation].sort((a, b) => a.orderIndex - b.orderIndex);

  let assistantStep = 0;

  return (
    <div className="space-y-3">
      {sorted.map((msg) => {
        if (msg.role === "system") {
          const text = msg.parts.find((p) => p.type === "text")?.textValue;
          if (!text) return null;
          return <SystemMessageBlock key={msg.id} text={text} />;
        }

        if (msg.role === "user") {
          const text = msg.parts.find((p) => p.type === "text")?.textValue;
          if (!text) return null;
          return <UserMessageBlock key={msg.id} text={text} />;
        }

        if (msg.role === "assistant") {
          assistantStep++;
          return (
            <AssistantStepBlock
              key={msg.id}
              msg={msg}
              stepIndex={assistantStep}
            />
          );
        }

        return null;
      })}

      {sorted.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 text-center">
          No conversation data recorded.
        </p>
      )}

      {rawJson !== undefined && (
        <div className="border-t pt-3">
          <button
            className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={() => setShowRaw(!showRaw)}
          >
            {showRaw ? "Hide" : "Show"} Raw JSON
          </button>
          {showRaw && (
            <pre className="mt-2 whitespace-pre-wrap text-xs font-mono bg-muted rounded-md p-3 overflow-auto max-h-[600px]">
              {rawJson ? JSON.stringify(rawJson, null, 2) : "No legacy step data."}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
