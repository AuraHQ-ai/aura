import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPatch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { CheckCircle2, ShieldCheck, Pencil, Save, X } from "lucide-react";

export interface EvalScore {
  id: string;
  messageId: string;
  partId: string | null;
  verdict: "fulfilled" | "partial" | "failed" | null;
  scorable: boolean;
  servingIntent: string | null;
  resolvedInWindow: boolean | null;
  failureClass: string;
  note: string | null;
  goldAnswer: string | null;
  rubric: { mustDo?: string[]; mustNotDo?: string[] } | null;
  ratifiedBy: string | null;
  judgeModel: string | null;
}

const VERDICT_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  fulfilled: "default",
  partial: "outline",
  failed: "destructive",
};

const FAILURE_CLASSES = [
  "none",
  "missing_cred",
  "bad_memory",
  "bad_harness",
  "missing_tool",
  "reasoning",
  "latency",
];

export function VerdictBadge({ score }: { score: EvalScore }) {
  if (!score.scorable) {
    return (
      <Badge variant="ghost" className="text-muted-foreground">
        not scorable
      </Badge>
    );
  }
  return (
    <Badge variant={VERDICT_VARIANT[score.verdict ?? ""] ?? "secondary"}>
      {score.verdict ?? "—"}
    </Badge>
  );
}

function AdjudicationForm({ score }: { score: EvalScore }) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(score.note ?? "");
  const [goldAnswer, setGoldAnswer] = useState(score.goldAnswer ?? "");
  const [verdict, setVerdict] = useState<string>(score.verdict ?? "none");
  const [failureClass, setFailureClass] = useState(score.failureClass);
  const [mustDo, setMustDo] = useState((score.rubric?.mustDo ?? []).join("\n"));
  const [mustNotDo, setMustNotDo] = useState((score.rubric?.mustNotDo ?? []).join("\n"));

  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => apiPatch(`/eval/scores/${score.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["eval"] });
      setEditing(false);
    },
  });

  function save() {
    const rubric =
      mustDo.trim() || mustNotDo.trim()
        ? {
            mustDo: mustDo.split("\n").map((s) => s.trim()).filter(Boolean),
            mustNotDo: mustNotDo.split("\n").map((s) => s.trim()).filter(Boolean),
          }
        : null;
    mutation.mutate({
      note: note || null,
      goldAnswer: goldAnswer || null,
      verdict: verdict === "none" ? null : verdict,
      failureClass,
      rubric,
    });
  }

  function toggleRatify() {
    mutation.mutate({
      ratifiedBy: score.ratifiedBy ? null : session?.slackUserId ?? session?.name ?? "human",
    });
  }

  if (!editing) {
    return (
      <div className="space-y-1.5">
        {score.note && <p className="text-xs text-muted-foreground">{score.note}</p>}
        {score.goldAnswer && (
          <div className="text-xs">
            <span className="font-medium">Gold:</span>{" "}
            <span className="text-muted-foreground">{score.goldAnswer}</span>
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="h-3 w-3" /> Adjudicate
          </Button>
          <Button
            variant={score.ratifiedBy ? "default" : "outline"}
            size="sm"
            onClick={toggleRatify}
            disabled={mutation.isPending}
            title={score.ratifiedBy ? `Ratified by ${score.ratifiedBy}` : "Ratify as bench-case candidate"}
          >
            <ShieldCheck className="h-3 w-3" />
            {score.ratifiedBy ? `Ratified` : "Ratify"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex gap-2">
        <Select value={verdict} onValueChange={setVerdict}>
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue placeholder="verdict" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">no verdict</SelectItem>
            <SelectItem value="fulfilled">fulfilled</SelectItem>
            <SelectItem value="partial">partial</SelectItem>
            <SelectItem value="failed">failed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={failureClass} onValueChange={setFailureClass}>
          <SelectTrigger className="h-8 w-[150px] text-xs">
            <SelectValue placeholder="failure class" />
          </SelectTrigger>
          <SelectContent>
            {FAILURE_CLASSES.map((fc) => (
              <SelectItem key={fc} value={fc}>
                {fc}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note — why did this fulfill / fumble the intent?"
        className="min-h-[48px] text-xs"
      />
      <Textarea
        value={goldAnswer}
        onChange={(e) => setGoldAnswer(e.target.value)}
        placeholder="Gold answer (optional, human-authored)"
        className="min-h-[48px] text-xs"
      />
      <div className="grid grid-cols-2 gap-2">
        <Textarea
          value={mustDo}
          onChange={(e) => setMustDo(e.target.value)}
          placeholder="Rubric — must do (one per line)"
          className="min-h-[48px] text-xs"
        />
        <Textarea
          value={mustNotDo}
          onChange={(e) => setMustNotDo(e.target.value)}
          placeholder="Rubric — must NOT do (one per line)"
          className="min-h-[48px] text-xs"
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={mutation.isPending}>
          <Save className="h-3 w-3" /> {mutation.isPending ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
          <X className="h-3 w-3" /> Cancel
        </Button>
      </div>
    </div>
  );
}

export function EvalScoreCard({ score }: { score: EvalScore }) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 space-y-2",
        score.verdict === "failed" && score.scorable && "border-destructive/40",
      )}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <VerdictBadge score={score} />
        {score.scorable && score.failureClass !== "none" && (
          <Badge variant="outline" className="text-xs">
            {score.failureClass}
          </Badge>
        )}
        {score.resolvedInWindow && (
          <Badge variant="ghost" className="text-xs text-muted-foreground">
            <CheckCircle2 className="h-3 w-3" /> resolved in window
          </Badge>
        )}
        {score.servingIntent && (
          <span className="text-xs text-muted-foreground truncate">
            intent: {score.servingIntent}
          </span>
        )}
        {score.judgeModel && (
          <span className="ml-auto text-[10px] text-muted-foreground font-mono">
            {score.judgeModel}
          </span>
        )}
      </div>
      <AdjudicationForm score={score} />
    </div>
  );
}

/**
 * Renders the eval funnel verdicts for a conversation trace, next to the trace
 * viewer. This is the role-2 adjudication surface: humans read the trace, write
 * note/gold, set ratified_by.
 */
export function EvalScorePanel({ traceId }: { traceId: string }) {
  const { data } = useQuery({
    queryKey: ["eval", "trace", traceId],
    queryFn: () => apiGet<{ items: EvalScore[] }>(`/eval/trace/${traceId}`),
  });

  const items = data?.items ?? [];
  if (items.length === 0) return null;

  return (
    <div className="space-y-2 rounded-xl border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Eval verdicts</h3>
        <span className="text-xs text-muted-foreground">
          {items.length} response{items.length === 1 ? "" : "s"} scored
        </span>
      </div>
      <div className="space-y-2">
        {items.map((score) => (
          <EvalScoreCard key={score.id} score={score} />
        ))}
      </div>
    </div>
  );
}
