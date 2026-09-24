/**
 * Slack tool-card title resolution.
 *
 * Precedence: per-call `label` input → derived `slack.status(input)` →
 * static `slack.status` string → caller fallback.
 *
 * Labels are sanitized at the render layer (trim + 60-char cap) because
 * models can emit padded or oversized values even when the schema says
 * otherwise.
 */

export const TOOL_CARD_LABEL_MAX_CHARS = 60;

export type SlackCardStatus<TInput = any> =
  | string
  | ((input: TInput) => string);

export function sanitizeToolCardLabel(label: unknown): string | undefined {
  if (typeof label !== "string") return undefined;
  const trimmed = label.trim();
  if (!trimmed) return undefined;
  return trimmed.length > TOOL_CARD_LABEL_MAX_CHARS
    ? trimmed.slice(0, TOOL_CARD_LABEL_MAX_CHARS)
    : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function resolveToolCardTitle(opts: {
  input?: unknown;
  status?: SlackCardStatus;
  fallback: string;
}): string {
  const args = isRecord(opts.input) ? opts.input : {};
  const label = sanitizeToolCardLabel(args.label);
  if (label) return label;

  const { status } = opts;
  if (typeof status === "function") {
    try {
      const derived = status(args);
      if (typeof derived === "string" && derived.trim()) return derived;
    } catch {
      // Display-only — never let a status formatter break the stream.
    }
  } else if (typeof status === "string" && status) {
    return status;
  }

  return opts.fallback;
}
