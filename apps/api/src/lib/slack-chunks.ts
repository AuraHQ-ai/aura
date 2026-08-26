/**
 * Slack streaming chunk hygiene.
 *
 * `chat.appendStream` / `chat.stopStream` validate every element of `chunks`
 * server-side against the Block Kit chunk schemas. A single malformed chunk
 * rejects the WHOLE batch with `invalid_arguments` and the metadata message
 * `failed to match exactly one allowed schema [json-pointer:/chunks/N]`.
 * Under `agent_view` + `@slack/web-api` v8 this surfaced as: text silently
 * never reaching Slack, then one bulk `postMessage` dump at the end.
 *
 * Shapes verified live against the Slack API (Aug 27, 2026) to be rejected:
 *   - `task_update` without `id`
 *   - `task_update` with `status` outside "pending"|"in_progress"|"complete"|"error"
 *   - `task_update` with `details: null` / `output: null` (undefined is fine — JSON drops it)
 *   - `task_update` whose `sources[]` entry lacks `text`
 *   - `markdown_text` without a string `text`
 * Shapes verified to be ACCEPTED: empty `text`, whitespace-only `text`, empty
 * `sources: []`, missing `title`, unknown extra keys, `blocks: []`.
 *
 * `sanitizeChunks` coerces every chunk to a schema-conformant shape (or drops
 * it, with a reason) BEFORE it is sent, and the types are the real
 * `@slack/types` ones so a wrong enum or a missing required field is a
 * compile-time error at the call site rather than a silent runtime drop.
 */
import type { ChatAppendStreamArguments } from "@slack/web-api";

// Derived from the v8 `chat.appendStream` argument type (which is built on
// `@slack/types`' `AnyChunk`), so these stay in lock-step with the installed
// client without a direct dependency on `@slack/types`.
export type AnyChunk = NonNullable<ChatAppendStreamArguments["chunks"]>[number];
export type BlocksChunk = Extract<AnyChunk, { type: "blocks" }>;
export type MarkdownTextChunk = Extract<AnyChunk, { type: "markdown_text" }>;
export type PlanUpdateChunk = Extract<AnyChunk, { type: "plan_update" }>;
export type TaskUpdateChunk = Extract<AnyChunk, { type: "task_update" }>;

export type TaskStatus = TaskUpdateChunk["status"];
export type URLSource = NonNullable<TaskUpdateChunk["sources"]>[number];

export const TASK_STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "complete", "error"];

/** Slack's documented cap on distinct task ids per stream (extra tasks are dropped server-side). */
export const MAX_TASKS_PER_STREAM = 50;
/** Slack's documented cap on blocks per `blocks` chunk. */
export const MAX_BLOCKS_PER_CHUNK = 50;

/** Common aliases the model / tool metadata might produce for a task status. */
const STATUS_ALIASES: Record<string, TaskStatus> = {
  completed: "complete",
  done: "complete",
  success: "complete",
  succeeded: "complete",
  ok: "complete",
  failed: "error",
  failure: "error",
  errored: "error",
  running: "in_progress",
  started: "in_progress",
  in_progress: "in_progress",
  inprogress: "in_progress",
  queued: "pending",
  waiting: "pending",
};

export const DEFAULT_TASK_TITLE = "Working on it...";

export interface DroppedChunk {
  reason: string;
  chunk: unknown;
}

export interface SanitizedChunks {
  chunks: AnyChunk[];
  dropped: DroppedChunk[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the value if it's a non-empty string, else undefined (null/""/non-string all collapse). */
function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function coerceStatus(value: unknown): TaskStatus | undefined {
  if (typeof value !== "string") return undefined;
  if ((TASK_STATUSES as readonly string[]).includes(value)) return value as TaskStatus;
  return STATUS_ALIASES[value.toLowerCase()];
}

function coerceSources(value: unknown): URLSource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: URLSource[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const url = optionalText(entry.url);
    if (!url) continue;
    // `text` is REQUIRED by the schema — fall back to the URL itself.
    const text = optionalText(entry.text) ?? url;
    out.push({ type: "url", url, text });
  }
  // An empty list is accepted by Slack but carries no information; omit it.
  return out.length > 0 ? out : undefined;
}

/**
 * Coerce one chunk-like value into a schema-valid chunk, or return a drop
 * reason. Never throws.
 */
export function sanitizeChunk(
  input: unknown,
): { chunk: AnyChunk } | { reason: string } {
  if (!isPlainObject(input)) return { reason: "not an object" };
  const type = input.type;

  switch (type) {
    case "markdown_text": {
      const text = input.text;
      if (typeof text !== "string") {
        // A markdown_text chunk MUST carry a string `text`. Coerce scalars,
        // drop anything else (null/undefined/object).
        if (typeof text === "number" || typeof text === "boolean") {
          return { chunk: { type: "markdown_text", text: String(text) } };
        }
        return { reason: "markdown_text.text is not a string" };
      }
      return { chunk: { type: "markdown_text", text } };
    }

    case "task_update": {
      const id = input.id;
      const idStr =
        typeof id === "string" ? id
        : typeof id === "number" ? String(id)
        : undefined;
      if (!idStr) return { reason: "task_update.id missing" };

      const status = coerceStatus(input.status);
      if (!status) return { reason: `task_update.status invalid (${String(input.status)})` };

      const chunk: TaskUpdateChunk = {
        type: "task_update",
        id: idStr,
        // `title` is optional server-side but required by the type; a stable
        // default keeps the card readable when metadata is missing.
        title: optionalText(input.title) ?? DEFAULT_TASK_TITLE,
        status,
      };
      const details = optionalText(input.details);
      if (details) chunk.details = details;
      const output = optionalText(input.output);
      if (output) chunk.output = output;
      const sources = coerceSources(input.sources);
      if (sources) chunk.sources = sources;
      return { chunk };
    }

    case "plan_update": {
      const title = optionalText(input.title);
      if (!title) return { reason: "plan_update.title missing" };
      return { chunk: { type: "plan_update", title } };
    }

    case "blocks": {
      const blocks = input.blocks;
      if (!Array.isArray(blocks)) return { reason: "blocks.blocks is not an array" };
      const valid = blocks.filter(isPlainObject);
      if (valid.length === 0) return { reason: "blocks.blocks is empty" };
      return {
        chunk: {
          type: "blocks",
          blocks: valid.slice(0, MAX_BLOCKS_PER_CHUNK) as unknown as BlocksChunk["blocks"],
        },
      };
    }

    default:
      return { reason: `unknown chunk type (${String(type)})` };
  }
}

/**
 * Sanitize a batch. Order is preserved; invalid chunks are dropped (not
 * fatal) and reported so the caller can log them.
 */
export function sanitizeChunks(inputs: readonly unknown[] | undefined | null): SanitizedChunks {
  const chunks: AnyChunk[] = [];
  const dropped: DroppedChunk[] = [];
  for (const input of inputs ?? []) {
    const result = sanitizeChunk(input);
    if ("chunk" in result) chunks.push(result.chunk);
    else dropped.push({ reason: result.reason, chunk: input });
  }
  return { chunks, dropped };
}

/** Keep only the text-bearing chunks — the safest possible retry payload. */
export function markdownOnly(chunks: readonly AnyChunk[]): MarkdownTextChunk[] {
  return chunks.filter((c): c is MarkdownTextChunk => c.type === "markdown_text" && c.text.length > 0);
}

/** Compact, size-capped JSON of a payload for logs / error_events. */
export function describeChunks(value: unknown, maxBytes = 600): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    json = String(value);
  }
  if (json === undefined) return "undefined";
  return json.length > maxBytes ? `${json.slice(0, maxBytes)}…(+${json.length - maxBytes}b)` : json;
}

/** Slack's `response_metadata.messages` for a failed call, joined. */
export function slackErrorDetail(err: unknown): string | undefined {
  const data = (err as { data?: { response_metadata?: { messages?: unknown } } } | undefined)?.data;
  const messages = data?.response_metadata?.messages;
  if (Array.isArray(messages) && messages.length > 0) return messages.map(String).join(" | ");
  return undefined;
}

/**
 * True when Slack rejected the chunk payload itself (schema validation), as
 * opposed to stream state / channel type / size errors. Both `invalid_chunks`
 * and `invalid_arguments` are emitted depending on which validation layer
 * trips; the json-pointer in the metadata is the reliable tell.
 */
export function isChunkSchemaRejection(err: unknown): boolean {
  const code = (err as { data?: { error?: string } } | undefined)?.data?.error;
  const msg = (err as { message?: string } | undefined)?.message ?? "";
  const detail = slackErrorDetail(err) ?? "";
  if (detail.includes("/chunks")) return true;
  return (
    code === "invalid_chunks" ||
    code === "invalid_arguments" ||
    msg.includes("invalid_chunks") ||
    msg.includes("invalid_arguments")
  );
}
