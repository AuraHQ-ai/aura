/**
 * Slack tool-card title resolution.
 *
 * Precedence: per-call `label` input → poller reuse of a cached launcher
 * label → derived `slack.status(input)` → static `slack.status` string →
 * caller fallback.
 *
 * Labels are sanitized at the render layer (trim + 60-char cap) because
 * models can emit padded or oversized values even when the schema says
 * otherwise.
 */

export const TOOL_CARD_LABEL_MAX_CHARS = 60;

export type SlackCardStatus<TInput = any> =
  | string
  | ((input: TInput) => string);

export type LaunchLabelCache = Map<string, string>;

const LAUNCHER_TOOLS = new Set([
  "run_command",
  "run_command_detached",
  "dispatch_cursor_agent",
]);

const POLLER_KIND: Record<string, "command" | "agent"> = {
  check_command: "command",
  check_cursor_agent: "agent",
};

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

function firstStringField(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Command id / agent id from a launcher tool result. */
export function extractLaunchId(output: unknown): string | undefined {
  if (!isRecord(output)) return undefined;
  return firstStringField(output, ["id", "agent_id"]);
}

/** Command id / agent id from a poller tool input. */
export function extractPollerTargetId(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return firstStringField(input, ["id", "agent_id"]);
}

export function rememberLaunchLabel(
  cache: LaunchLabelCache,
  id: unknown,
  label: unknown,
): boolean {
  const key = typeof id === "string" ? id.trim() : "";
  const value = sanitizeToolCardLabel(label);
  if (!key || !value) return false;
  cache.set(key, value);
  return true;
}

/**
 * Persist a launcher's per-call label keyed by the id in its tool result
 * so a later check_command / check_cursor_agent can reuse it.
 */
export function rememberLaunchLabelFromCall(opts: {
  cache: LaunchLabelCache;
  toolName?: string;
  input?: unknown;
  output?: unknown;
}): boolean {
  if (!opts.toolName || !LAUNCHER_TOOLS.has(opts.toolName)) return false;
  const label = isRecord(opts.input) ? opts.input.label : undefined;
  return rememberLaunchLabel(opts.cache, extractLaunchId(opts.output), label);
}

export function formatPollerCardTitle(
  kind: "command" | "agent",
  label: string,
): string {
  return kind === "agent"
    ? `checking agent '${label}'`
    : `checking job '${label}'`;
}

export function resolveToolCardTitle(opts: {
  input?: unknown;
  status?: SlackCardStatus;
  fallback: string;
  toolName?: string;
  launchLabels?: LaunchLabelCache;
}): string {
  const args = isRecord(opts.input) ? opts.input : {};
  const label = sanitizeToolCardLabel(args.label);
  if (label) return label;

  const kind = opts.toolName ? POLLER_KIND[opts.toolName] : undefined;
  if (kind && opts.launchLabels) {
    const targetId = extractPollerTargetId(args);
    const cached = targetId ? opts.launchLabels.get(targetId) : undefined;
    if (cached) return formatPollerCardTitle(kind, cached);
  }

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
