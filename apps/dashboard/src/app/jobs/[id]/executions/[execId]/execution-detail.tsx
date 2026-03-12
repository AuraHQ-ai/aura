"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { JobExecution, JobExecutionMessage, JobExecutionPart } from "@schema";

type ConversationMessage = JobExecutionMessage & { parts: JobExecutionPart[] };

interface ExecutionData {
  execution: JobExecution;
  conversation: ConversationMessage[];
}

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

function PromptBlock({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap text-xs font-mono bg-muted rounded-md p-3 overflow-auto max-h-[600px]">
      {text}
    </pre>
  );
}

function ToolInvocationBlock({ part }: { part: JobExecutionPart }) {
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

function TimelineView({ conversation }: { conversation: ConversationMessage[] }) {
  const assistantMsgs = conversation.filter((m) => m.role === "assistant");
  const [filter, setFilter] = useState("");

  const filteredMsgs = filter
    ? assistantMsgs
        .map((msg) => ({
          ...msg,
          parts: msg.parts.filter(
            (p) =>
              p.toolName?.toLowerCase().includes(filter.toLowerCase()) ||
              p.textValue?.toLowerCase().includes(filter.toLowerCase()),
          ),
        }))
        .filter((msg) => msg.parts.length > 0)
    : assistantMsgs;

  return (
    <div className="space-y-3">
      <input
        type="text"
        placeholder="Filter by tool name or text..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="w-full px-3 py-1.5 text-sm border rounded-md bg-background"
      />

      {filteredMsgs.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 text-center">
          {filter ? "No matching steps." : "No assistant steps recorded."}
        </p>
      )}

      {filteredMsgs.map((msg, msgIdx) => (
        <div key={msg.id} className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary" className="text-[10px]">
              Step {msgIdx + 1}
            </Badge>
            <span>{formatDate(msg.createdAt)}</span>
          </div>

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
                    <pre className="whitespace-pre-wrap text-xs font-mono overflow-auto max-h-[400px]">
                      {part.textValue}
                    </pre>
                  </Collapsible>
                );
              }

              if (part.type === "tool-invocation") {
                return <ToolInvocationBlock key={part.id} part={part} />;
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
      ))}
    </div>
  );
}

export function ExecutionDetail({
  data,
  jobId,
}: {
  data: ExecutionData;
  jobId: string;
}) {
  const { execution, conversation } = data;

  const systemMsg = conversation.find((m) => m.role === "system");
  const userMsg = conversation.find((m) => m.role === "user");

  const systemPrompt =
    systemMsg?.parts.find((p) => p.type === "text")?.textValue ?? null;
  const userPrompt =
    userMsg?.parts.find((p) => p.type === "text")?.textValue ?? null;

  const hasConversation = conversation.length > 0;
  const tokenUsage = execution.tokenUsage as {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;

  return (
    <>
      <div className="flex items-center gap-3">
        <Link href={`/jobs/${jobId}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-base font-semibold">Execution Detail</h1>
          <p className="text-xs text-muted-foreground font-mono">
            {execution.id}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge
            variant={
              execution.status === "completed"
                ? "success"
                : execution.status === "failed"
                  ? "destructive"
                  : "secondary"
            }
          >
            {execution.status}
          </Badge>
          <Badge variant="outline">{execution.trigger}</Badge>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Started</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm">{formatDate(execution.startedAt)}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Finished</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm">
              {formatDate(execution.finishedAt)}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            {tokenUsage ? (
              <div className="text-sm space-y-0.5">
                <div>
                  In: {tokenUsage.inputTokens?.toLocaleString() ?? "—"}
                </div>
                <div>
                  Out: {tokenUsage.outputTokens?.toLocaleString() ?? "—"}
                </div>
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">—</span>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Error</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm text-muted-foreground">
              {execution.error || "—"}
            </span>
          </CardContent>
        </Card>
      </div>

      {execution.summary && (
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{execution.summary}</p>
          </CardContent>
        </Card>
      )}

      {!hasConversation && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No conversation data recorded for this execution.
            {execution.steps != null && (
              <span> Legacy step data is available in the raw JSON below.</span>
            )}
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue={hasConversation ? "timeline" : "raw"}>
        <TabsList>
          {hasConversation && (
            <>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="system">System Prompt</TabsTrigger>
              <TabsTrigger value="user">User Prompt</TabsTrigger>
            </>
          )}
          <TabsTrigger value="raw">Raw Steps</TabsTrigger>
        </TabsList>

        {hasConversation && (
          <>
            <TabsContent value="timeline">
              <TimelineView conversation={conversation} />
            </TabsContent>

            <TabsContent value="system">
              <Card>
                <CardContent className="pt-4">
                  {systemPrompt ? (
                    <Collapsible
                      title={`System Prompt (${systemPrompt.length.toLocaleString()} chars)`}
                      defaultOpen
                    >
                      <PromptBlock text={systemPrompt} />
                    </Collapsible>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No system prompt recorded.
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="user">
              <Card>
                <CardContent className="pt-4">
                  {userPrompt ? (
                    <Collapsible
                      title={`User Prompt (${userPrompt.length.toLocaleString()} chars)`}
                      defaultOpen
                    >
                      <PromptBlock text={userPrompt} />
                    </Collapsible>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No user prompt recorded.
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </>
        )}

        <TabsContent value="raw">
          <Card>
            <CardContent className="pt-4">
              {execution.steps ? (
                <pre className="whitespace-pre-wrap text-xs font-mono bg-muted rounded-md p-3 overflow-auto max-h-[600px]">
                  {JSON.stringify(execution.steps, null, 2)}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No step data available.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
