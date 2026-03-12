"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { UnifiedTimeline } from "@/components/unified-timeline";
import type { ConversationMessageWithParts } from "@/components/unified-timeline";
import type { JobExecution } from "@schema";

interface ExecutionData {
  execution: JobExecution;
  conversation: ConversationMessageWithParts[];
  conversationTraceId?: string | null;
  costUsd?: string | null;
}

export function ExecutionDetail({
  data,
  jobId,
}: {
  data: ExecutionData;
  jobId: string;
}) {
  const { execution, conversation, conversationTraceId, costUsd } = data;

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
          {conversationTraceId && (
            <Link href={`/conversations/${conversationTraceId}`}>
              <Button variant="outline" size="sm">
                <ExternalLink className="h-3.5 w-3.5" />
                View full conversation
              </Button>
            </Link>
          )}
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

      <div className="grid gap-3 md:grid-cols-5">
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
            <CardTitle>Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm font-mono">
              {costUsd ? `$${parseFloat(costUsd).toFixed(4)}` : "—"}
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

      <UnifiedTimeline conversation={conversation} rawJson={execution.steps} />
    </>
  );
}
