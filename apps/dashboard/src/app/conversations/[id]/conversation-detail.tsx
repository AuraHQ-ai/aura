"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { UnifiedTimeline } from "@/components/unified-timeline";
import type { ConversationMessageWithParts } from "@/components/unified-timeline";
import type { ConversationTrace } from "@schema";

interface ConversationData {
  trace: ConversationTrace;
  conversation: ConversationMessageWithParts[];
  jobName: string | null;
  jobId: string | null;
}

export function ConversationDetail({ data }: { data: ConversationData }) {
  const { trace, conversation, jobName, jobId } = data;

  const tokenUsage = trace.tokenUsage as {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails?: {
      noCacheTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    outputTokenDetails?: {
      textTokens?: number;
      reasoningTokens?: number;
    };
  } | null;

  const costUsd = (trace as any).costUsd as string | null;

  return (
    <>
      <div className="flex items-center gap-3">
        <Link href="/conversations">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-base font-semibold">Conversation Detail</h1>
          <p className="text-xs text-muted-foreground font-mono">
            {trace.id}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge
            variant={trace.sourceType === "interactive" ? "default" : "secondary"}
          >
            {trace.sourceType === "job_execution" ? "job" : "interactive"}
          </Badge>
          {trace.sourceType === "job_execution" && trace.jobExecutionId && jobId && (
            <Link href={`/jobs/${jobId}/executions/${trace.jobExecutionId}`}>
              <Button variant="outline" size="sm">
                <ExternalLink className="h-3.5 w-3.5" />
                View execution
              </Button>
            </Link>
          )}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-5">
        <Card>
          <CardHeader>
            <CardTitle>Timestamp</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm">{formatDate(trace.createdAt)}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Source</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm space-y-0.5">
              {trace.sourceType === "job_execution" ? (
                <div>{jobName ?? "Unknown job"}</div>
              ) : (
                <>
                  {trace.channelId && <div>Channel: {trace.channelId}</div>}
                  {trace.userId && <div>User: {trace.userId}</div>}
                  {trace.threadTs && <div className="font-mono text-xs text-muted-foreground">Thread: {trace.threadTs}</div>}
                </>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Model</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm font-mono">{trace.modelId ?? "—"}</span>
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
                <div>In: {tokenUsage.inputTokens?.toLocaleString() ?? "—"}</div>
                {tokenUsage.inputTokenDetails && (
                  <div className="text-xs text-muted-foreground pl-2">
                    {tokenUsage.inputTokenDetails.cacheReadTokens != null && (
                      <span>cache read: {tokenUsage.inputTokenDetails.cacheReadTokens.toLocaleString()} </span>
                    )}
                    {tokenUsage.inputTokenDetails.cacheWriteTokens != null && (
                      <span>write: {tokenUsage.inputTokenDetails.cacheWriteTokens.toLocaleString()}</span>
                    )}
                  </div>
                )}
                <div>Out: {tokenUsage.outputTokens?.toLocaleString() ?? "—"}</div>
                {tokenUsage.outputTokenDetails?.reasoningTokens != null && tokenUsage.outputTokenDetails.reasoningTokens > 0 && (
                  <div className="text-xs text-muted-foreground pl-2">
                    reasoning: {tokenUsage.outputTokenDetails.reasoningTokens.toLocaleString()}
                  </div>
                )}
                <div className="text-muted-foreground">Total: {tokenUsage.totalTokens?.toLocaleString() ?? "—"}</div>
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">—</span>
            )}
          </CardContent>
        </Card>
      </div>

      <UnifiedTimeline conversation={conversation} />
    </>
  );
}
