import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailSkeleton } from "@/components/page-skeleton";
import {
  UnifiedTimeline,
  type ConversationMessageWithParts,
} from "@/components/unified-timeline";
import { formatDate } from "@/lib/utils";
import { ArrowLeft, ExternalLink } from "lucide-react";

interface TokenUsage {
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
}

interface Trace {
  id: string;
  sourceType: string;
  channelId: string | null;
  userId: string | null;
  threadTs: string | null;
  modelId: string | null;
  tokenUsage: TokenUsage | null;
  costUsd: string | null;
  createdAt: string;
}

export interface ConversationData {
  trace: Trace;
  conversation: ConversationMessageWithParts[];
  jobName: string | null;
  jobId: string | null;
}

function ConversationMetadataCards({
  trace,
  jobName,
}: {
  trace: Trace;
  jobName: string | null;
}) {
  const tokenUsage = trace.tokenUsage;
  const costUsd = trace.costUsd;

  return (
    <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
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
                {trace.threadTs && (
                  <div className="font-mono text-xs text-muted-foreground">
                    Thread: {trace.threadTs}
                  </div>
                )}
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
              <div>
                In: {tokenUsage.inputTokens?.toLocaleString() ?? "—"}
              </div>
              {tokenUsage.inputTokenDetails && (
                <div className="text-xs text-muted-foreground pl-2">
                  {tokenUsage.inputTokenDetails.cacheReadTokens != null && (
                    <span>
                      cache read:{" "}
                      {tokenUsage.inputTokenDetails.cacheReadTokens.toLocaleString()}{" "}
                    </span>
                  )}
                  {tokenUsage.inputTokenDetails.cacheWriteTokens != null && (
                    <span>
                      write:{" "}
                      {tokenUsage.inputTokenDetails.cacheWriteTokens.toLocaleString()}
                    </span>
                  )}
                </div>
              )}
              <div>
                Out: {tokenUsage.outputTokens?.toLocaleString() ?? "—"}
              </div>
              {tokenUsage.outputTokenDetails?.reasoningTokens != null &&
                tokenUsage.outputTokenDetails.reasoningTokens > 0 && (
                  <div className="text-xs text-muted-foreground pl-2">
                    reasoning:{" "}
                    {tokenUsage.outputTokenDetails.reasoningTokens.toLocaleString()}
                  </div>
                )}
              <div className="text-muted-foreground">
                Total: {tokenUsage.totalTokens?.toLocaleString() ?? "—"}
              </div>
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function ConversationDetailView({
  data,
  embedded = false,
}: {
  data: ConversationData;
  embedded?: boolean;
}) {
  const { trace, conversation, jobName, jobId } = data;

  return (
    <>
      <div className="flex items-center gap-3 flex-wrap">
        {!embedded && (
          <Button variant="ghost" size="icon-sm" asChild>
            <Link to="/conversations">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
        )}
        <div className="min-w-0 flex-1">
          {!embedded && (
            <h1 className="text-base font-semibold">Conversation Detail</h1>
          )}
          <p className="text-xs text-muted-foreground font-mono truncate">
            {trace.id}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge
            variant={
              trace.sourceType === "interactive" ? "default" : "secondary"
            }
          >
            {trace.sourceType === "job_execution" ? "job" : "interactive"}
          </Badge>
          {trace.sourceType === "job_execution" && jobId && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/jobs/$id" params={{ id: jobId }}>
                <ExternalLink className="h-3.5 w-3.5" />
                View job
              </Link>
            </Button>
          )}
        </div>
      </div>

      <ConversationMetadataCards trace={trace} jobName={jobName} />

      <UnifiedTimeline conversation={conversation} />
    </>
  );
}

function ConversationDetailPage() {
  const { id } = Route.useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["conversations", id],
    queryFn: () => apiGet<ConversationData>(`/conversations/${id}`),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error)
    return (
      <div className="text-destructive text-sm">
        Failed to load conversation: {error.message}
      </div>
    );
  if (!data) return null;

  return (
    <div className="space-y-4">
      <ConversationDetailView data={data} />
    </div>
  );
}

export const Route = createFileRoute("/conversations/$id")({
  component: ConversationDetailPage,
});
