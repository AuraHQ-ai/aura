import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPatch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { DetailSkeleton } from "@/components/page-skeleton";
import {
  VerdictBadge,
  FailureClassBadge,
  type EvalScore,
} from "@/components/eval-verdict-badge";
import { ConversationDetailView, type ConversationData } from "../conversations/$id";
import { formatDate } from "@/lib/utils";
import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle, Undo2 } from "lucide-react";

interface EvalScoreDetail extends EvalScore {
  userId: string | null;
  channelId: string | null;
  modelId: string | null;
  costUsd: string | null;
  respondedAt: string;
}

function linesToList(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function AdjudicationPanel({ score }: { score: EvalScoreDetail }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState(score.note ?? "");
  const [goldAnswer, setGoldAnswer] = useState(score.goldAnswer ?? "");
  const [mustDo, setMustDo] = useState((score.rubric?.must_do ?? []).join("\n"));
  const [mustNotDo, setMustNotDo] = useState(
    (score.rubric?.must_not_do ?? []).join("\n"),
  );

  useEffect(() => {
    setNote(score.note ?? "");
    setGoldAnswer(score.goldAnswer ?? "");
    setMustDo((score.rubric?.must_do ?? []).join("\n"));
    setMustNotDo((score.rubric?.must_not_do ?? []).join("\n"));
  }, [score.id]);

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPatch<EvalScoreDetail>(`/eval/${score.id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["eval-scores"] });
      queryClient.invalidateQueries({ queryKey: ["eval-score", score.id] });
      queryClient.invalidateQueries({ queryKey: ["eval-funnel"] });
    },
  });

  function save() {
    const mustDoList = linesToList(mustDo);
    const mustNotDoList = linesToList(mustNotDo);
    const rubric =
      mustDoList.length > 0 || mustNotDoList.length > 0
        ? {
            ...(mustDoList.length > 0 ? { must_do: mustDoList } : {}),
            ...(mustNotDoList.length > 0 ? { must_not_do: mustNotDoList } : {}),
          }
        : null;
    mutation.mutate({
      note: note.trim() || null,
      goldAnswer: goldAnswer.trim() || null,
      rubric,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Adjudication</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Note</label>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="mt-1"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            Gold answer (human-authored)
          </label>
          <Textarea
            value={goldAnswer}
            onChange={(e) => setGoldAnswer(e.target.value)}
            rows={4}
            className="mt-1"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Rubric: must do (one per line)
            </label>
            <Textarea
              value={mustDo}
              onChange={(e) => setMustDo(e.target.value)}
              rows={4}
              className="mt-1"
              placeholder={"honor the stated preference\ncite the tool output"}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Rubric: must not do (one per line)
            </label>
            <Textarea
              value={mustNotDo}
              onChange={(e) => setMustNotDo(e.target.value)}
              rows={4}
              className="mt-1"
              placeholder={"claim context was lost\ninvent numbers"}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={save} disabled={mutation.isPending}>
            Save
          </Button>
          {score.ratifiedBy ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => mutation.mutate({ ratify: false })}
              disabled={mutation.isPending}
            >
              <Undo2 className="h-3.5 w-3.5" />
              Un-ratify (by {score.ratifiedBy})
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => mutation.mutate({ ratify: true })}
              disabled={mutation.isPending}
            >
              <CheckCircle className="h-3.5 w-3.5" />
              Ratify verdict
            </Button>
          )}
          {mutation.isError && (
            <span className="text-xs text-destructive">
              {(mutation.error as Error).message}
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Ratified <span className="font-mono">failed</span> responses become
          bench-case candidates for the curated regression bench.
        </p>
      </CardContent>
    </Card>
  );
}

function ScoreSummary({ score }: { score: EvalScoreDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Judge verdict</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <VerdictBadge verdict={score.verdict} scorable={score.scorable} />
          <FailureClassBadge failureClass={score.failureClass} />
          {score.resolvedInWindow && (
            <Badge variant="outline">resolved in window</Badge>
          )}
          {score.ratifiedBy && (
            <Badge variant="success">ratified by {score.ratifiedBy}</Badge>
          )}
        </div>
        {score.servingIntent && (
          <div>
            <span className="text-xs font-medium text-muted-foreground block">
              Serving intent
            </span>
            {score.servingIntent}
          </div>
        )}
        {score.note && (
          <div>
            <span className="text-xs font-medium text-muted-foreground block">
              Judge note
            </span>
            {score.note}
          </div>
        )}
        <div className="text-xs text-muted-foreground space-y-0.5 pt-1">
          <div>
            Judge model: <span className="font-mono">{score.judgeModel}</span>
          </div>
          <div>Scored: {formatDate(score.createdAt)}</div>
          <div>Responded: {formatDate(score.respondedAt)}</div>
          {score.threadTs && (
            <div className="font-mono">Thread: {score.threadTs}</div>
          )}
          <div className="font-mono">Part: {score.partId}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function EvalDetailPage() {
  const { id } = Route.useParams();

  const { data: score, isLoading, error } = useQuery({
    queryKey: ["eval-score", id],
    queryFn: () => apiGet<EvalScoreDetail>(`/eval/${id}`),
  });

  const { data: conversation } = useQuery({
    queryKey: ["conversations", score?.traceId],
    queryFn: () => apiGet<ConversationData>(`/conversations/${score!.traceId}`),
    enabled: !!score?.traceId,
  });

  if (isLoading) return <DetailSkeleton />;
  if (error)
    return (
      <div className="text-destructive text-sm">
        Failed to load eval score: {error.message}
      </div>
    );
  if (!score) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/evals">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">Response score</h1>
          <p className="text-xs text-muted-foreground font-mono truncate">
            {score.id}
          </p>
        </div>
        {score.channelId && score.threadTs && (
          <Button variant="outline" size="sm" asChild>
            <Link
              to="/conversations/threads/$channelId/$threadTs"
              params={{ channelId: score.channelId, threadTs: score.threadTs }}
              search={{ highlight: score.respondedAt }}
            >
              View full thread
            </Link>
          </Button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ScoreSummary score={score} />
        <AdjudicationPanel score={score} />
      </div>

      <div className="space-y-4">
        <h2 className="text-sm font-semibold tracking-tight">Trace</h2>
        {conversation ? (
          <ConversationDetailView data={conversation} embedded />
        ) : (
          <p className="text-sm text-muted-foreground">Loading trace…</p>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/evals/$id")({
  component: EvalDetailPage,
});
