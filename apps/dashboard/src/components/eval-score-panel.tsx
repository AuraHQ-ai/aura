import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { apiPatch } from "@/lib/api";
import { formatDate } from "@/lib/utils";

export interface EvalResponseScore {
  workspaceId: string;
  messageId: string;
  partId: string;
  traceId: string;
  threadTs: string | null;
  servingIntent: string | null;
  resolvedInWindow: boolean;
  verdict: "fulfilled" | "partial" | "failed";
  scorable: boolean;
  failureClass: string;
  note: string | null;
  goldAnswer: string | null;
  rubric: { must_do?: string[]; must_not_do?: string[] } | null;
  ratifiedBy: string | null;
  judgeModel: string;
  createdAt: string;
}

function verdictVariant(verdict: EvalResponseScore["verdict"]) {
  if (verdict === "failed") return "destructive";
  if (verdict === "partial") return "warning";
  return "success";
}

function formatRubric(rubric: EvalResponseScore["rubric"]): string {
  if (!rubric) return "";
  return JSON.stringify(rubric, null, 2);
}

function parseRubric(value: string): EvalResponseScore["rubric"] {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed) as EvalResponseScore["rubric"];
}

export function EvalScorePanel({
  traceId,
  scores,
}: {
  traceId: string;
  scores: EvalResponseScore[];
}) {
  const queryClient = useQueryClient();
  const [selectedPartId, setSelectedPartId] = useState<string | null>(
    scores[0]?.partId ?? null,
  );

  useEffect(() => {
    if (!selectedPartId || !scores.some((score) => score.partId === selectedPartId)) {
      setSelectedPartId(scores[0]?.partId ?? null);
    }
  }, [scores, selectedPartId]);

  const selected = useMemo(
    () => scores.find((score) => score.partId === selectedPartId) ?? scores[0] ?? null,
    [scores, selectedPartId],
  );

  const [note, setNote] = useState("");
  const [goldAnswer, setGoldAnswer] = useState("");
  const [rubricText, setRubricText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setNote(selected?.note ?? "");
    setGoldAnswer(selected?.goldAnswer ?? "");
    setRubricText(formatRubric(selected?.rubric ?? null));
    setFormError(null);
  }, [selected]);

  const mutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (!selected) throw new Error("No selected score");
      return apiPatch<EvalResponseScore>(`/eval-scores/${selected.partId}`, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const counts = useMemo(() => {
    return {
      failed: scores.filter((score) => score.verdict === "failed").length,
      partial: scores.filter((score) => score.verdict === "partial").length,
      fulfilled: scores.filter((score) => score.verdict === "fulfilled").length,
      ratified: scores.filter((score) => score.ratifiedBy).length,
    };
  }, [scores]);

  if (scores.length === 0) {
    return (
      <Card className="lg:sticky lg:top-4">
        <CardHeader>
          <CardTitle>Eval score</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            This trace has not been scored yet. The nightly scorer inserts one row per
            assistant text response part.
          </p>
          <p className="mt-3 text-xs font-mono text-muted-foreground break-all">
            {traceId}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="lg:sticky lg:top-4">
      <CardHeader>
        <CardTitle>Eval scores</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-4 gap-2 text-center text-xs">
          <div className="rounded-md border p-2">
            <div className="font-semibold">{counts.fulfilled}</div>
            <div className="text-muted-foreground">pass</div>
          </div>
          <div className="rounded-md border p-2">
            <div className="font-semibold">{counts.partial}</div>
            <div className="text-muted-foreground">partial</div>
          </div>
          <div className="rounded-md border p-2">
            <div className="font-semibold">{counts.failed}</div>
            <div className="text-muted-foreground">failed</div>
          </div>
          <div className="rounded-md border p-2">
            <div className="font-semibold">{counts.ratified}</div>
            <div className="text-muted-foreground">ratified</div>
          </div>
        </div>

        <div className="space-y-2">
          {scores.map((score) => (
            <button
              key={score.partId}
              type="button"
              onClick={() => setSelectedPartId(score.partId)}
              className={`w-full rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                selected?.partId === score.partId ? "bg-muted" : "hover:bg-muted/50"
              }`}
            >
              <div className="flex items-center gap-2">
                <Badge variant={verdictVariant(score.verdict)} className="text-[10px]">
                  {score.verdict}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {score.scorable ? "scorable" : "skip"}
                </Badge>
                {score.ratifiedBy && (
                  <Badge variant="secondary" className="ml-auto text-[10px]">
                    ratified
                  </Badge>
                )}
              </div>
              <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                {score.partId.slice(0, 8)} · {score.failureClass}
              </div>
            </button>
          ))}
        </div>

        {selected && (
          <div className="space-y-3 border-t pt-4">
            <div className="space-y-1 text-xs">
              <div className="flex items-center gap-2">
                <Badge variant={verdictVariant(selected.verdict)}>
                  {selected.verdict}
                </Badge>
                <Badge variant="outline">{selected.failureClass}</Badge>
              </div>
              <div className="text-muted-foreground">
                Intent: {selected.servingIntent ?? "—"}
              </div>
              <div className="text-muted-foreground">
                Resolved in window: {selected.resolvedInWindow ? "yes" : "no"}
              </div>
              <div className="text-muted-foreground">
                Judge: <span className="font-mono">{selected.judgeModel}</span>
              </div>
              <div className="text-muted-foreground">
                Scored: {formatDate(selected.createdAt)}
              </div>
              {selected.ratifiedBy && (
                <div className="text-muted-foreground">
                  Ratified by: <span className="font-mono">{selected.ratifiedBy}</span>
                </div>
              )}
            </div>

            <label className="block space-y-1 text-xs">
              <span className="font-medium">Note</span>
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Human adjudication note"
                className="min-h-24 text-xs"
              />
            </label>

            <label className="block space-y-1 text-xs">
              <span className="font-medium">Gold answer</span>
              <Textarea
                value={goldAnswer}
                onChange={(event) => setGoldAnswer(event.target.value)}
                placeholder="Expected answer or behavior"
                className="min-h-24 text-xs"
              />
            </label>

            <label className="block space-y-1 text-xs">
              <span className="font-medium">Rubric JSON</span>
              <Textarea
                value={rubricText}
                onChange={(event) => setRubricText(event.target.value)}
                placeholder='{"must_do":[],"must_not_do":[]}'
                className="min-h-24 font-mono text-xs"
              />
            </label>

            {formError && <div className="text-xs text-destructive">{formError}</div>}
            {mutation.error && (
              <div className="text-xs text-destructive">{mutation.error.message}</div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  try {
                    setFormError(null);
                    mutation.mutate({
                      note,
                      goldAnswer,
                      rubric: parseRubric(rubricText),
                    });
                  } catch (error) {
                    setFormError(error instanceof Error ? error.message : "Invalid rubric JSON");
                  }
                }}
                disabled={mutation.isPending}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant={selected.ratifiedBy ? "outline" : "default"}
                onClick={() => mutation.mutate({ ratified: !selected.ratifiedBy })}
                disabled={mutation.isPending}
              >
                {selected.ratifiedBy ? "Unratify" : "Ratify failure"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
