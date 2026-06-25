import { Badge } from "@/components/ui/badge";

/** A row from eval_response_scores, as returned by the dashboard API. */
export interface EvalScore {
  id: string;
  messageId: string;
  partId: string;
  traceId: string;
  threadTs: string | null;
  servingIntent: string | null;
  resolvedInWindow: boolean;
  verdict: "fulfilled" | "partial" | "failed" | null;
  scorable: boolean;
  failureClass: string;
  note: string | null;
  goldAnswer: string | null;
  rubric: { must_do?: string[]; must_not_do?: string[] } | null;
  ratifiedBy: string | null;
  judgeModel: string;
  createdAt: string;
}

export function verdictVariant(
  verdict: EvalScore["verdict"],
): "success" | "warning" | "destructive" | "secondary" {
  switch (verdict) {
    case "fulfilled":
      return "success";
    case "partial":
      return "warning";
    case "failed":
      return "destructive";
    default:
      return "secondary";
  }
}

export function VerdictBadge({
  verdict,
  scorable,
  className,
}: {
  verdict: EvalScore["verdict"];
  scorable: boolean;
  className?: string;
}) {
  if (!scorable || !verdict) {
    return (
      <Badge variant="secondary" className={className}>
        not scorable
      </Badge>
    );
  }
  return (
    <Badge variant={verdictVariant(verdict)} className={className}>
      {verdict}
    </Badge>
  );
}

export function FailureClassBadge({
  failureClass,
  className,
}: {
  failureClass: string;
  className?: string;
}) {
  if (!failureClass || failureClass === "none") return null;
  return (
    <Badge variant="outline" className={className}>
      {failureClass.replace(/_/g, " ")}
    </Badge>
  );
}
