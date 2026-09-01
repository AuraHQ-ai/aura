import { streamText } from "ai";
import type { ChatAppendStreamArguments, WebClient } from "@slack/web-api";
import type { ModelMessage } from "ai";
import type { FileContentPart } from "../lib/files.js";
import { logger } from "../lib/logger.js";
import { logError } from "../lib/error-logger.js";
import { formatForSlack, prettifyAndWrapTable } from "../lib/format.js";
import { TABLE_BLOCK_KEY } from "../tools/table.js";
import { CHART_BLOCK_KEY } from "../tools/chart.js";
import { ALERT_BLOCK_KEY } from "../tools/alert.js";
import { CARD_BLOCK_KEY } from "../tools/card.js";
import {
  safePostMessage,
  isChannelTypeNotSupported,
  isInvalidArguments,
  isInvalidBlocks,
  isInvalidChunks,
  isMsgTooLong,
} from "../lib/slack-messaging.js";
import { getDetachedCommandSuspendState, getSlackMeta } from "../lib/tool.js";
import {
  startTurnMarker,
  finishTurnMarker,
  type TurnMarkerTerminalStatus,
} from "../lib/turn-markers.js";
import { createInteractiveAgent } from "../lib/agents.js";
import { getMainModel, buildCachedSystemMessages } from "../lib/ai.js";
import { aiTelemetry } from "../lib/langfuse.js";
import { InvocationSupersededError } from "./prepare-step.js";
import { cleanupScratchpad } from "../tools/scratchpad.js";
import { cacheDeferredToolResolutions } from "../tools/deferred.js";
import type { DetailedTokenUsage } from "@aura/db/schema";
import { getSettingJSON } from "../lib/settings.js";
import {
  sanitizeChunks,
  markdownOnly,
  describeChunks,
  slackErrorDetail,
  isChunkSchemaRejection,
  type AnyChunk,
  type BlocksChunk,
  type MarkdownTextChunk,
  type TaskUpdateChunk,
  type URLSource,
} from "../lib/slack-chunks.js";
import { getSupersedeReason, interruptionNote, isInvocationCurrent } from "../lib/invocation-lock.js";

// ── Tool I/O Persistence ─────────────────────────────────────────────────────
// Accumulated during streaming and attached as invisible Slack message metadata
// so that follow-up turns can see actual tool inputs and outputs.

export const TOOL_IO_EVENT_TYPE = "aura_tool_io";

/** Max bytes for serialized tool I/O metadata (Slack limit is 16 KB). */
const METADATA_BUDGET = 8_000;

export interface ToolCallRecord {
  /** Tool name */
  name: string;
  /** JSON-serialized input args */
  input: string;
  /** JSON-serialized (and truncated) output */
  output: string;
  /** Whether the tool errored */
  is_error: boolean;
  /** Raw (untruncated) output object, available for post-processing */
  rawOutput?: unknown;
}

/** Truncate a string to fit within a byte budget, appending "…" if cut. */
function truncateToBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const buf = Buffer.from(s, "utf8");
  let end = maxBytes - 3;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8") + "…";
}

/** Serialize tool output with per-tool truncation. */
function serializeToolOutput(toolName: string, output: any): string {
  if (output == null) return "";
  if (typeof output !== "object") return String(output);

  switch (toolName) {
    case "bq_execute_query": {
      if (output.rows && Array.isArray(output.rows)) {
        const capped = { ...output, rows: output.rows.slice(0, 50) };
        if (output.rows.length > 50) capped._truncated = true;
        return truncateToBytes(JSON.stringify(capped), 3000);
      }
      return truncateToBytes(JSON.stringify(output), 3000);
    }
    case "run_command":
      return truncateToBytes(JSON.stringify(output), 2000);
    case "web_search":
    case "read_url":
      return truncateToBytes(JSON.stringify(output), 2000);
    default:
      return truncateToBytes(JSON.stringify(output), 1500);
  }
}

/** Build Slack message metadata from accumulated tool call records. */
function buildToolMetadata(
  records: ToolCallRecord[],
): { event_type: string; event_payload: Record<string, any> } | null {
  if (records.length === 0) return null;

  const payload: Record<string, any> = {
    tool_calls: records.map((r) => ({
      name: r.name,
      input: r.input,
      output: r.output,
      is_error: r.is_error,
    })),
  };

  let serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") <= METADATA_BUDGET) {
    return { event_type: TOOL_IO_EVENT_TYPE, event_payload: payload };
  }

  // Dynamically compute per-field budget based on record count so the
  // total stays within METADATA_BUDGET regardless of how many records exist.
  const perRecordOverhead = 70; // JSON keys, quotes, braces, commas
  const perFieldBudget = Math.max(
    50,
    Math.floor((METADATA_BUDGET / records.length - perRecordOverhead) / 2),
  );

  let trimmed = records.map((r) => ({
    name: r.name,
    input: truncateToBytes(r.input, perFieldBudget),
    output: truncateToBytes(r.output, perFieldBudget),
    is_error: r.is_error,
  }));

  serialized = JSON.stringify({ tool_calls: trimmed });
  while (Buffer.byteLength(serialized, "utf8") > METADATA_BUDGET && trimmed.length > 1) {
    trimmed = trimmed.slice(1);
    serialized = JSON.stringify({ tool_calls: trimmed });
  }

  return { event_type: TOOL_IO_EVENT_TYPE, event_payload: { tool_calls: trimmed } };
}


// ── Task Card Helpers ────────────────────────────────────────────────────────

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}


// ── Types ────────────────────────────────────────────────────────────────────

interface RespondOptions {
  /** Stable across all requests (cached globally) */
  stablePrefix: string;
  /** Per-user "what you can do" layer (capabilities + storage), cached ahead of the conversation */
  environmentContext: string;
  /** Stable within a conversation thread (cached per-thread) */
  conversationContext: string;
  /** Dynamic per-call context (time, model, channel) — passed as uncached system message */
  dynamicContext?: string;
  userMessage: string;
  slackClient: WebClient;
  context?: { userId?: string; channelId?: string; threadTs?: string; workspaceId?: string; timezone?: string };
  files?: FileContentPart[];
  channelId: string;
  threadTs?: string;
  /** ts of the user message this turn responds to (turn marker bookkeeping) */
  messageTs?: string;
  /** Slack team ID — required for chatStream in channels */
  teamId?: string;
  /** Slack user ID of the message author — required for chatStream in channels */
  recipientUserId?: string;
  /** Channel type for smart routing (skip streaming on unsupported types) */
  channelType?: import("./context.js").ChannelType;
  /** Whether this is a headless/job execution (skip streaming, go straight to safePostMessage) */
  isHeadless?: boolean;
  /** Invocation ID for conversation interruption detection */
  invocationId?: string;
}

export interface LLMResponse {
  /** The raw LLM output */
  raw: string;
  /** Whether the response was already posted to Slack via streaming */
  alreadyPosted: boolean;
  /** Token usage */
  usage?: DetailedTokenUsage;
  /** Tool calls executed during this response */
  toolCalls: ToolCallRecord[];
  /** Model ID used for this response */
  modelId?: string;
  /** Promise that resolves to the conversation steps (for persistence) */
  stepsPromise?: PromiseLike<any[]>;
  /** Canonical gateway model ID used for each step in order */
  stepModelIds?: string[];
  /** Per-turn context-compaction totals (issue #1328), for the trace row */
  compactionTotals?: { compactedToolResults: number; compactionTokensSaved: number };
  /** Whether the response was interrupted by a newer invocation */
  interrupted?: boolean;
  /** Whether the turn was delegated to the durable WDK workflow (issue #1111) */
  workflowDelegated?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isUnsupportedFileError(error: any): boolean {
  const msg = error?.message || error?.toString() || "";
  const name = error?.name || "";
  return (
    name === "AI_UnsupportedFunctionalityError" ||
    name === "AI_NoOutputGeneratedError" ||
    msg.includes("UnsupportedFunctionality") ||
    msg.includes("NoOutputGenerated") ||
    msg.includes("unsupported file") ||
    msg.includes("unsupported mime")
  );
}

// ── Stream Continuation ──────────────────────────────────────────────────────
// Slack's chatStream rejects appends when accumulated content exceeds ~10K
// chars with `msg_too_long`. We proactively split into continuation messages
// using cascading boundary detection to find clean break points.

const STREAM_THRESHOLD_NEWLINE = 7_000;
const STREAM_THRESHOLD_SENTENCE = 8_000;
const STREAM_THRESHOLD_WHITESPACE = 9_000;
const STREAM_HARD_LIMIT = 9_500;
const MAX_CONTINUATIONS = 5;
const LONG_TOOL_SPLIT_MS = 75_000;
// Slack's chat.stream transport enforces a hard cap (~3 minutes) on the TOTAL
// lifetime of a single stream, independent of activity. Keepalive appends only
// beat the ~30s idle timeout — they do NOT extend the lifetime cap — and
// LONG_TOOL_SPLIT_MS only covers a single tool staying pending past 75s. Turns
// made of many sequential short tool calls (20-40s each) accumulate past the
// cap, the stream dies at the transport layer, and composed text never flushes
// (issue #1121). We proactively split to a fresh stream once the current one
// exceeds this wall-clock age, checked at safe boundaries (text-delta and
// tool-result/tool-error handling) — never mid-append.
const STREAM_MAX_AGE_MS = 60_000;
const STREAM_CONTINUATION_TOMBSTONE = "_(continuing in a new message...)_";
const TOOL_CONTINUATION_OUTPUT = "continuing in a new message...";
const EMPTY_COMPLETION_RELAUNCH_PROMPT = "(continue - you ended without responding. Summarize what you found.)";

/**
 * Find the best split index in a text delta for stream continuation.
 * Returns the char offset within `delta` at which to split: text before
 * stays in the current stream, text from this offset goes to a new one.
 * Returns -1 if no split is needed yet.
 */
function findContinuationBreak(delta: string, streamLength: number): number {
  if (streamLength >= STREAM_HARD_LIMIT) return 0;

  const candidates: number[] = [];

  if (streamLength >= STREAM_THRESHOLD_NEWLINE) {
    const idx = delta.indexOf("\n");
    if (idx >= 0) candidates.push(idx + 1);
  }

  if (streamLength >= STREAM_THRESHOLD_SENTENCE) {
    const idx = delta.indexOf(". ");
    if (idx >= 0) candidates.push(idx + 2);
  }

  if (streamLength >= STREAM_THRESHOLD_WHITESPACE) {
    const idx = delta.search(/\s/);
    if (idx >= 0) candidates.push(idx + 1);
    if (streamLength + delta.length >= STREAM_HARD_LIMIT) {
      candidates.push(Math.max(0, STREAM_HARD_LIMIT - streamLength));
    }
  }

  if (candidates.length === 0) return -1;
  return Math.min(...candidates);
}

function estimateAppendSize(payload: any): number {
  if (Array.isArray(payload?.chunks)) return JSON.stringify(payload.chunks).length;
  if (payload.markdown_text) return payload.markdown_text.length;
  return JSON.stringify(payload).length;
}

// Slack accepts exactly `timeline` (default) | `plan` for chat.startStream
// `task_display_mode` (https://docs.slack.dev/reference/methods/chat.startStream).
// "hybrid" was never a valid value — it would make the lazy startStream fail
// on the first append and silently drop the whole turn to postMessage.
type SlackTaskDisplayMode = "timeline" | "plan";
// Chunk shapes are the real `@slack/types` contracts (see lib/slack-chunks.ts)
// so a wrong status enum or a missing required field fails `tsc`, not Slack.
type SlackStreamChunk = AnyChunk;

function normalizeTaskDisplayMode(value: unknown): SlackTaskDisplayMode {
  if (value === "plan" || value === "timeline") return value;
  if (value === "hybrid") {
    logger.warn("slack_task_display_mode 'hybrid' is not a Slack value; using 'timeline'");
  }
  return "timeline";
}

function toChunkMarkdownText(text: string): MarkdownTextChunk {
  return {
    type: "markdown_text",
    text,
    // Keep chunk payload shape minimal for live API compatibility.
  };
}

function toTaskUpdateChunk(params: {
  id: string;
  title: string;
  status: TaskUpdateChunk["status"];
  details?: string;
  output?: string;
  sources?: URLSource[];
}): TaskUpdateChunk {
  return {
    type: "task_update",
    ...params,
  };
}

function toBlocksChunk(blocks: Record<string, any>[]): BlocksChunk {
  return {
    type: "blocks",
    blocks: blocks as BlocksChunk["blocks"],
  };
}

function fallbackTextForNativeBlock(block: Record<string, any>) {
  switch (block.type) {
    case "data_visualization":
      return "Here's a chart:";
    case "alert":
      return "Heads up:";
    case "card":
      return "Here's a summary:";
    default:
      return "Here's a table:";
  }
}

function asAppendPayload(payload: {
  markdown_text?: string;
  chunks?: SlackStreamChunk[];
}): Omit<ChatAppendStreamArguments, "channel" | "ts"> {
  // Always stream in chunks mode to avoid `streaming_mode_mismatch`.
  const raw: unknown[] = [];
  if (payload.markdown_text != null) {
    raw.push(toChunkMarkdownText(payload.markdown_text));
  }
  if (payload.chunks && payload.chunks.length > 0) {
    raw.push(...payload.chunks);
  }

  // Every chunk is coerced to the exact server schema (or dropped) BEFORE it
  // leaves the process — one malformed element rejects the whole batch
  // (`invalid_arguments … [json-pointer:/chunks/N]`) and the text in that
  // batch would never reach Slack.
  const { chunks, dropped } = sanitizeChunks(raw);
  if (dropped.length > 0) {
    logger.warn("Dropped malformed Slack stream chunk(s) before append", {
      dropped: dropped.map((d) => ({ reason: d.reason, chunk: describeChunks(d.chunk, 300) })),
    });
  }
  if (chunks.length > 0) {
    return { chunks };
  }
  return {};
}

/** Channels known to not support streaming (persists for process lifetime) */
const streamingUnsupportedChannels = new Set<string>();

// ── Main Function ────────────────────────────────────────────────────────────

/**
 * Stream LLM response to Slack using native chatStream API.
 *
 * Uses Slack's chat.startStream / chat.appendStream / chat.stopStream
 * (via the WebClient.chatStream() helper) for native streaming UX with
 * built-in buffering and rate limit handling.
 *
 * Tool calls are displayed as native Slack task cards in timeline mode.
 *
 * Falls back to chat.postMessage for channels that don't support streaming
 * (e.g. Slack List item comment threads).
 */
export async function generateResponse(
  options: RespondOptions,
): Promise<LLMResponse> {
  const start = Date.now();
  const { slackClient, channelId, threadTs } = options;
  const hasFiles = options.files && options.files.length > 0;
  const invocationId = options.invocationId ?? crypto.randomUUID();

  // ── Turn marker (stream-death watchdog, issue #1109) ────────────────
  // Ground-truth "turn started" row, marked terminal on every in-process
  // exit path below. If the process is hard-killed (Vercel maxDuration
  // SIGKILL), the row stays in "started" and the heartbeat watchdog posts
  // a recovery message. Headless/job turns are excluded — jobs have their
  // own stale-running recovery in the heartbeat.
  // startTurnMarker is fail-soft: a marker failure never breaks the turn.
  const trackTurnMarker = options.isHeadless !== true;
  // Terminal status recorded in the finally block. Defaults to "failed" so
  // any exit that doesn't explicitly flip it (thrown errors handled by the
  // caller's pipeline catch) is still terminal — the watchdog only acts on
  // rows stuck in "started".
  let turnMarkerStatus: TurnMarkerTerminalStatus = "failed";
  if (trackTurnMarker) {
    await startTurnMarker({
      invocationId,
      channelId,
      threadTs,
      messageTs: options.messageTs,
      userId: options.context?.userId,
      workspaceId: options.context?.workspaceId,
    });
  }

  // ── Smart routing: skip streaming when it's known to fail ──────────
  const skipStreaming =
    options.isHeadless === true ||
    options.channelType === "slack_list_item" ||
    streamingUnsupportedChannels.has(channelId);

  // ── Start native Slack stream ───────────────────────────────────────
  // thread_ts is required by chat.startStream — the caller must always
  // provide it (even for DMs, use the user's message ts).
  if (!threadTs) {
    throw new Error("threadTs is required for chatStream (chat.startStream requires thread_ts)");
  }

  // Typed against v8's `chat.startStream` contract so an unknown/misspelled
  // param is a compile error (this used to be `Record<string, any>` + `as any`).
  const streamParams: Parameters<WebClient["chatStream"]>[0] = {
    channel: channelId,
    thread_ts: threadTs,
  };

  // recipient_team_id and recipient_user_id are required for channels
  if (options.teamId) streamParams.recipient_team_id = options.teamId;
  if (options.recipientUserId) streamParams.recipient_user_id = options.recipientUserId;

  let streamer: any = null;
  // Wall-clock start time of the CURRENT Slack stream. Reset whenever
  // splitToNewStream() creates a fresh stream — NOT between tool results —
  // so it tracks total stream age for the STREAM_MAX_AGE_MS check.
  let streamStartedAt = Date.now();

  // ── Streaming fallback ──────────────────────────────────────────────
  // Some channel types (e.g. Slack List internal channels) don't support
  // chat.startStream. When we detect this, we flip to buffer-only mode
  // and post the final result via chat.postMessage.
  let streamingFailed = skipStreaming;
  // Slack refused an append with `stopped_by_user` (Stop button): terminal,
  // and the buffered text must NOT be re-posted as a fallback.
  let stoppedByUser = false;
  let streamTombstoneSent = false;
  let pendingMessageNotInStreamingStateError: Parameters<typeof logError>[0] | null = null;
  let pendingChannelTypeUnsupportedFallback: { errorMessage: string } | null = null;

  function logChannelTypeUnsupportedFallbackFailure(
    fallbackFailure: string,
    deliveryError?: any,
  ): void {
    if (!pendingChannelTypeUnsupportedFallback) return;
    logError({
      errorName: "StreamingUnsupported",
      errorMessage: pendingChannelTypeUnsupportedFallback.errorMessage,
      errorCode: "channel_type_not_supported",
      channelId,
      context: {
        fallback: "postMessage",
        fallbackFailure,
        ...(deliveryError && {
          deliveryError: deliveryError?.message || String(deliveryError),
          slackError: deliveryError?.data?.error,
        }),
      },
    });
    pendingChannelTypeUnsupportedFallback = null;
  }

  /**
   * Write the stashed message_not_in_streaming_state error to error_events.
   * Always logged regardless of fallback outcome (issue #1121); the
   * `fallbackRecovered` tag lets dashboards separate recovered from
   * unrecovered occurrences.
   */
  function flushPendingMessageNotInStreamingStateError(recovered: boolean): void {
    if (!pendingMessageNotInStreamingStateError) return;
    const pending = pendingMessageNotInStreamingStateError;
    pendingMessageNotInStreamingStateError = null;
    logError({
      ...pending,
      context: { ...(pending.context ?? {}), fallbackRecovered: recovered },
    });
  }

  async function tryStreamAppend(
    payload: Omit<ChatAppendStreamArguments, "channel" | "ts">,
  ): Promise<boolean> {
    if (streamingFailed || !streamer) return false;
    try {
      await streamer.append(payload);
      return true;
    } catch (err: any) {
      if (isChannelTypeNotSupported(err)) {
        streamingFailed = true;
        streamingUnsupportedChannels.add(channelId);
        logger.warn(
          "chatStream not supported for this channel, falling back to postMessage",
          { channelId },
        );
        pendingChannelTypeUnsupportedFallback = {
          errorMessage: err?.message || "channel_type_not_supported",
        };
      } else if (isChunkSchemaRejection(err) || isInvalidChunks(err) || isInvalidArguments(err)) {
        // Non-fatal: Slack rejected the chunk payload (`invalid_chunks` or
        // `invalid_arguments` depending on which validation layer trips —
        // the `[json-pointer:/chunks/N]` metadata is the reliable tell).
        // The batch is atomic, so any markdown text in it was NOT delivered:
        // retry with the text-only subset so the user still sees the words,
        // then keep streaming. Log the exact rejected payload — sanitizeChunks
        // should make this unreachable, so a hit here is a new Slack schema
        // change we need to see verbatim.
        const errCode = err?.data?.error || (isInvalidArguments(err) ? "invalid_arguments" : "invalid_chunks");
        const rejectedChunks = Array.isArray((payload as any)?.chunks)
          ? ((payload as any).chunks as AnyChunk[])
          : [];
        const chunkTypes = rejectedChunks.map((c) => c?.type).filter(Boolean);
        const slackDetail = slackErrorDetail(err);
        const rejectedPayload = describeChunks(payload);
        logger.warn("chatStream append rejected by Slack schema validation; retrying text-only", {
          channelId,
          slackError: errCode,
          slackDetail,
          chunkTypes,
          rejectedPayload,
        });

        let textRecovered = false;
        const textOnly = markdownOnly(rejectedChunks);
        if (textOnly.length > 0 && textOnly.length < rejectedChunks.length) {
          try {
            await streamer.append({ chunks: textOnly });
            textRecovered = true;
          } catch (retryErr: any) {
            logger.warn("Text-only retry after chunk rejection also failed", {
              channelId,
              slackError: retryErr?.data?.error || retryErr?.message,
              slackDetail: slackErrorDetail(retryErr),
            });
          }
        }

        logError({
          errorName: isInvalidArguments(err) ? "InvalidArguments" : "InvalidChunks",
          errorMessage: slackDetail
            ? `${errCode} on stream append: ${slackDetail}`
            : err?.message || `${errCode} on stream append`,
          errorCode: errCode,
          channelId,
          context: {
            chunkTypes,
            rejectedPayload,
            textRecovered,
            textChunkCount: textOnly.length,
          },
        });
        return textRecovered;
      } else if (err?.data?.error === "stopped_by_user") {
        // The user pressed Stop: Slack halted this stream and refuses further
        // appends. Terminal — do NOT fall back to postMessage (that would
        // dump the answer they just stopped). The turn unwinds via the
        // stop sentinel on the next step (see stopInvocation()).
        streamingFailed = true;
        stoppedByUser = true;
        logger.info("chatStream append refused: stopped_by_user — ending delivery", { channelId });
        return false;
      } else if (isInvalidBlocks(err)) {
        streamingFailed = true;
        logger.warn("chatStream append returned invalid_blocks, falling back to postMessage", {
          channelId,
          slackError: err?.data?.error,
          payloadKeys: Object.keys(payload),
        });
        logError({
          errorName: "InvalidBlocks",
          errorMessage: err?.message || "invalid_blocks on stream append",
          errorCode: err?.data?.error || "invalid_blocks",
          channelId,
          context: { payloadKeys: Object.keys(payload) },
        });
      } else if (isMsgTooLong(err)) {
        streamingFailed = true;
        logger.warn("chatStream append returned msg_too_long, falling back to postMessage", {
          channelId,
          currentStreamLength,
        });
        logError({
          errorName: "MsgTooLong",
          errorMessage: err?.message || "msg_too_long on stream append",
          errorCode: "msg_too_long",
          channelId,
          context: { currentStreamLength },
        });
      } else if (err?.data?.error === 'internal_error') {
        // Transient Slack server error — retry once after 500ms, then fall back
        try {
          await new Promise(r => setTimeout(r, 500));
          await streamer.append(payload);
          return true;
        } catch (retryErr: any) {
          streamingFailed = true;
          logger.warn("chatStream append failed on retry after internal_error, falling back to postMessage", {
            channelId,
            originalError: err?.data?.error,
            retryError: retryErr?.data?.error || retryErr?.message,
          });
          logError({
            errorName: "SlackInternalError",
            errorMessage: retryErr?.message || "error on stream append retry",
            errorCode: retryErr?.data?.error || "internal_error",
            channelId,
            context: { fallback: "postMessage", retried: true, originalError: err?.data?.error },
          });
        }
      } else {
        // Unknown streaming error — don't kill the response, fall back gracefully
        streamingFailed = true;

        if (err?.data?.error === "message_not_in_streaming_state") {
          // Stash for finalize: always written to error_events once the
          // fallback outcome is known, tagged recovered/unrecovered
          // (issue #1121 — previously swallowed when the fallback succeeded).
          pendingMessageNotInStreamingStateError = {
            errorName: "MessageNotInStreamingState",
            errorMessage: err?.message || "message_not_in_streaming_state on stream append",
            errorCode: "message_not_in_streaming_state",
            channelId,
            context: {
              fallback: "postMessage",
              streamAgeMs: Date.now() - streamStartedAt,
              toolCallCount: toolCallRecords.length,
            },
          };
          logger.warn("chatStream append left streaming state, falling back to postMessage", {
            channelId,
            slackError: err?.data?.error,
            message: err?.message,
          });
        } else {
          logger.error("chatStream append got unexpected error, falling back to postMessage", {
            channelId,
            slackError: err?.data?.error,
            message: err?.message,
          });
          logError({
            errorName: "UnexpectedStreamError",
            errorMessage: err?.message || "unexpected error on stream append",
            errorCode: err?.data?.error || "unknown",
            channelId,
            context: { fallback: "postMessage" },
          });
        }
      }
      if (streamingFailed) {
        await stopFrozenStreamWithTombstone();
      }
    }
    return false;
  }

  // ── Inactivity timeout ───────────────────────────────────────────────
  type StreamAbortReason = "inactivity" | "long_tool" | "superseded" | "unknown";
  type ContinuationReason = "length" | "long_tool" | "stream_age";

  const abortController = new AbortController();
  let inactivityTimer: ReturnType<typeof setTimeout> = undefined as any;
  let lastAbortReason: StreamAbortReason = "unknown";

  const resetTimer = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      logger.warn("LLM inactivity timeout (180s), aborting");
      lastAbortReason = "inactivity";
      // Log at the point of abort: the abort doesn't always surface as a
      // thrown AbortError (the SDK may end the stream gracefully), so the
      // catch-side StreamAborted log alone can miss these (issue #1121).
      logError({
        errorName: "StreamInactivityAbort",
        errorMessage: "LLM stream aborted after 180s of inactivity",
        errorCode: "stream_inactivity_abort",
        channelId,
        context: {
          accumulatedTextLength: accumulatedText.length,
          toolCallCount: toolCallRecords.length,
          segmentIndex: currentSegmentIndex,
          streamAgeMs: Date.now() - streamStartedAt,
        },
      });
      abortController.abort("inactivity");
    }, 180_000);
  };
  resetTimer();

  // Keepalive interval during long tool calls (e.g. Claude Code via run_command)
  let toolKeepAlive: ReturnType<typeof setInterval> | null = null;

  // Slack stream keepalive — sends minimal payload to prevent ~30s idle timeout
  let streamKeepAlive: ReturnType<typeof setInterval> | null = null;
  let longToolSplitTimer: ReturnType<typeof setTimeout> | null = null;
  let longToolSplitInFlight = false;

  // Declared before the agent so the getAccumulatedText closure below is
  // always safe to invoke; appended to in handleTextDelta during streaming.
  let accumulatedText = "";

  // ── Build agent ──────────────────────────────────────────────────────
  const { agent, tools, modelId, getStepModelIds, getCompactionTotals } = await createInteractiveAgent({
    slackClient: options.slackClient,
    context: options.context,
    stablePrefix: options.stablePrefix,
    environmentContext: options.environmentContext,
    conversationContext: options.conversationContext,
    dynamicContext: options.dynamicContext,
    invocationId,
    channelId: options.channelId,
    threadTs: options.threadTs,
    // Lets a hard-deadline continuation job carry the truncated message's
    // own "remaining work" promises verbatim (issue #1336).
    getAccumulatedText: () => accumulatedText,
  });

  const configuredTaskDisplayMode = normalizeTaskDisplayMode(
    (await getSettingJSON<SlackTaskDisplayMode>("slack_task_display_mode", "timeline")) ?? "timeline",
  );
  streamParams.task_display_mode = configuredTaskDisplayMode;

  if (!skipStreaming) {
    streamer = slackClient.chatStream(streamParams);
    streamStartedAt = Date.now();
  }

  let supersededDuringStream = false;
  const isSupersededError = (error: unknown): error is InvocationSupersededError => (
    error instanceof InvocationSupersededError ||
    (
      error instanceof Error &&
      (error.name === "InvocationSupersededError" ||
        error.message.includes("was superseded by a newer message"))
    )
  );

  // ── Mid-tool cancellation (issue #1355) ─────────────────────────────
  // prepareStep checks the lock once per model call, so a Stop press during
  // a long tool used to burn until the tool returned. The toolKeepAlive tick
  // (armed while a tool is pending) re-checks the lock here and aborts. The
  // abort is normalized back to InvocationSupersededError in the catch below
  // so it takes the same superseded unwind (`_[stopped]_`) as the
  // prepareStep path, never a raw AbortError.
  let supersedeCheckInFlight = false;
  let midToolSupersedeAbort = false;
  async function abortIfSuperseded(): Promise<void> {
    // Same guard as prepareStep: only turns that actually claimed the lock
    // participate (headless jobs get a random fallback invocationId and must
    // never be aborted by a stale lock row from an interactive turn).
    if (!options.invocationId || !threadTs) return;
    if (supersedeCheckInFlight || abortController.signal.aborted) return;
    supersedeCheckInFlight = true;
    try {
      const current = await isInvocationCurrent(channelId, threadTs, invocationId);
      if (!current && !abortController.signal.aborted) {
        logger.info("Invocation superseded mid-tool — aborting", {
          invocationId,
          channelId,
          pendingToolCount: pendingToolInputs.size,
        });
        supersededDuringStream = true;
        midToolSupersedeAbort = true;
        lastAbortReason = "superseded";
        abortController.abort("superseded");
      }
    } catch (err: any) {
      logger.warn("Mid-tool invocation check failed, assuming still current", {
        invocationId,
        error: err?.message,
      });
    } finally {
      supersedeCheckInFlight = false;
    }
  }

  const baseStreamCallOptions: Record<string, any> = {
    abortSignal: abortController.signal,
    onError: ({ error }: { error: unknown }) => {
      if (isSupersededError(error)) {
        supersededDuringStream = true;
        logger.info("Stream onError ignored — invocation superseded", {
          invocationId,
          channelId,
        });
        return;
      }

      const streamError = error instanceof Error ? error : undefined;
      const errorLike = error && typeof error === "object"
        ? error as { name?: string; message?: string; stack?: string }
        : undefined;
      logError({
        errorName: errorLike?.name || streamError?.name || "StreamMidFlightError",
        errorMessage: errorLike?.message || streamError?.message || String(error),
        errorCode: "stream_on_error_callback",
        channelId,
        context: { accumulatedTextLength: accumulatedText.length },
        stackTrace: errorLike?.stack || streamError?.stack,
      });
    },
  };

  function buildInitialUserMessage(): ModelMessage {
    if (hasFiles) {
      const content: any[] = [
        { type: "text", text: options.userMessage },
        ...options.files!,
      ];
      return { role: "user", content };
    }
    return { role: "user", content: options.userMessage };
  }

  const initialUserMessage = buildInitialUserMessage();
  const streamCallOptions: Record<string, any> = { ...baseStreamCallOptions };
  if (hasFiles) {
    streamCallOptions.messages = [initialUserMessage];
  } else {
    streamCallOptions.prompt = options.userMessage;
  }

  logger.info("Starting LLM stream", {
    model: modelId || "unknown",
    hasFiles,
    toolCount: Object.keys(tools || {}).length,
    promptLength: options.stablePrefix.length + options.environmentContext.length + options.conversationContext.length,
  });

  // ── Stream and send to Slack ────────────────────────────────────────
  let currentStreamLength = 0;
  let fallbackStartIdx = 0;
  let streamedRawIdx = 0;
  let pendingNativeBlocks: Record<string, any>[] = [];
  // Delivery receipt tracking for issue #1180: toolCallIds of the tool calls
  // that produced the pending blocks, so NativeBlockDelivered/NativeBlockDropped
  // events can be tied back to the draw_table/draw_chart invocations.
  let pendingNativeBlockToolCallIds: string[] = [];
  const toolCallRecords: ToolCallRecord[] = [];
  const pendingToolInputs = new Map<string, { name: string; input: string }>();
  const optimisticToolCards = new Map<string, { title: string }>();
  let deferredToolCachePersisted = false;
  const persistDeferredToolCache = async () => {
    if (deferredToolCachePersisted) return;
    deferredToolCachePersisted = true;
    await cacheDeferredToolResolutions(
      options.context ?? { channelId, threadTs },
      toolCallRecords.map((record) => record.name),
    );
  };
  // Issue #1342: prepareStep's supersede check only runs BETWEEN agent steps,
  // so a follow-up that arrives while the FINAL step is generating/streaming
  // would otherwise let both the old and new invocation post final answers to
  // the same thread. Re-check the conversation lock immediately before final
  // delivery (one indexed SELECT per turn). Fail-open on read errors — same
  // policy as the between-steps check in prepare-step.ts.
  const isCurrentAtFinalDelivery = async (deliveryPath: string): Promise<boolean> => {
    let stillCurrent = true;
    try {
      stillCurrent = await isInvocationCurrent(channelId, threadTs, invocationId);
    } catch (err: any) {
      logger.warn("Final-delivery invocation check failed, assuming still current", {
        invocationId,
        channelId,
        deliveryPath,
        error: err?.message,
      });
      return true;
    }
    if (!stillCurrent) {
      logger.info("Invocation superseded at final delivery — suppressing answer", {
        invocationId,
        channelId,
        threadTs,
        deliveryPath,
      });
      logError({
        errorName: "InvocationSupersededAtFinalDelivery",
        errorMessage: "Invocation superseded before final delivery; suppressing the answer",
        errorCode: "superseded_at_final_delivery",
        channelId,
        context: {
          invocationId,
          deliveryPath,
          accumulatedTextLength: accumulatedText.length,
          toolCallCount: toolCallRecords.length,
        },
      });
    }
    return stillCurrent;
  };
  let continuationCount = 0;
  let currentSegmentIndex = 0;
  let currentSegmentTextLength = 0;
  let currentSegmentToolRecordStart = 0;
  let currentSegmentContinuationReason: ContinuationReason | "root" = "root";
  const loggedEmptyContinuationSegments = new Set<number>();
  let tableBuffer: string[] = [];
  let lineCarry = "";
  let emptyCompletionDetected = false;
  let emptyCompletionRelaunchCount = 0;
  let turnSuspendedByDetachedCommand = false;
  let latestResult: Awaited<ReturnType<typeof agent.stream>> | null = null;
  const stepsPromises: Array<PromiseLike<any[]>> = [];
  const aggregateUsage: DetailedTokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  const emptyCompletionFallbackText = "_I ran the tools but didn't get usable output back. Can you tell me what to retry?_";

  async function logEmptyContinuationSegmentIfNeeded(params: {
    segmentEnd: "split" | "final";
    finishReason?: unknown;
  }): Promise<void> {
    if (currentSegmentIndex === 0) return;
    if (loggedEmptyContinuationSegments.has(currentSegmentIndex)) return;
    if (currentSegmentTextLength > 0) return;

    const segmentToolRecords = toolCallRecords.slice(currentSegmentToolRecordStart);
    if (segmentToolRecords.length === 0) return;

    loggedEmptyContinuationSegments.add(currentSegmentIndex);
    logError({
      errorName: "EmptyCompletion",
      errorMessage: "Continuation stream completed without usable output after tool calls",
      errorCode: "empty_completion_after_tools_continuation",
      channelId,
      context: {
        toolCallCount: segmentToolRecords.length,
        toolErrorCount: segmentToolRecords.filter((record) => record.is_error).length,
        segmentIndex: currentSegmentIndex,
        continuationReason: currentSegmentContinuationReason,
        segmentEnd: params.segmentEnd,
        finishReason: params.finishReason,
      },
    });

    if (params.segmentEnd === "final" && streamer && !streamingFailed) {
      try {
        const tombstone = "\n\n_...(no output generated in continuation — see Aura logs)_";
        currentStreamLength += tombstone.length;
        await streamer.append(asAppendPayload({ markdown_text: tombstone }));
      } catch {
        // Stream may already be unrecoverable; the error row above is the durable signal.
      }
    }
  }

  function clearLongToolSplitTimer() {
    if (longToolSplitTimer) {
      clearTimeout(longToolSplitTimer);
      longToolSplitTimer = null;
    }
  }

  function buildStreamTombstoneChunks(): SlackStreamChunk[] {
    const chunks: SlackStreamChunk[] = [];
    for (const [toolCallId, pending] of pendingToolInputs.entries()) {
      const slackMeta = getSlackMeta(tools[pending.name]);
      chunks.push(toTaskUpdateChunk({
        id: toolCallId,
        title: slackMeta?.status ?? "Working on it...",
        status: "complete",
        output: TOOL_CONTINUATION_OUTPUT,
      }));
    }
    chunks.push(toChunkMarkdownText(`\n${STREAM_CONTINUATION_TOMBSTONE}\n`));
    return chunks;
  }

  function buildOptimisticToolErrorChunks(errorMessage: string): SlackStreamChunk[] {
    return Array.from(optimisticToolCards.entries()).map(([toolCallId, card]) =>
      toTaskUpdateChunk({
        id: toolCallId,
        title: card.title,
        status: "error",
        output: truncate(errorMessage, 200),
      }),
    );
  }

  async function appendStreamTombstone(): Promise<void> {
    if (!streamer || streamTombstoneSent) return;
    const payload = asAppendPayload({ chunks: buildStreamTombstoneChunks() });
    try {
      currentStreamLength += estimateAppendSize(payload);
      await streamer.append(payload);
      streamTombstoneSent = true;
    } catch (err: any) {
      logger.warn("Failed to append stream continuation tombstone", {
        channelId,
        slackError: err?.data?.error,
        error: err?.message,
      });
    }
  }

  async function stopFrozenStreamWithTombstone(): Promise<void> {
    if (!streamer || streamTombstoneSent) return;
    try {
      await streamer.stop({ chunks: buildStreamTombstoneChunks() });
      streamTombstoneSent = true;
    } catch (err: any) {
      logger.warn("Failed to stop frozen stream with continuation tombstone", {
        channelId,
        slackError: err?.data?.error,
        error: err?.message,
      });
    }
  }

  /**
   * Process a text chunk through the table line buffer.
   * Holds back lines starting with `|` until the table ends, then wraps
   * completed tables (2+ rows) in triple-backtick fences so Slack renders
   * them as monospace. Returns text ready to be flushed to the stream.
   */
  function processChunkForTables(chunkText: string): string {
    lineCarry += chunkText;
    let output = "";

    let nlIdx: number;
    while ((nlIdx = lineCarry.indexOf("\n")) !== -1) {
      const line = lineCarry.slice(0, nlIdx + 1);
      lineCarry = lineCarry.slice(nlIdx + 1);

      if (line.trimStart().startsWith("|")) {
        tableBuffer.push(line);
      } else {
        if (tableBuffer.length > 0) {
          output += tableBuffer.length >= 2
            ? prettifyAndWrapTable(tableBuffer)
            : tableBuffer.join("");
          tableBuffer = [];
        }
        output += line;
      }
    }

    if (lineCarry) {
      if (tableBuffer.length === 0 && !lineCarry.trimStart().startsWith("|")) {
        output += lineCarry;
        lineCarry = "";
      } else if (tableBuffer.length > 0 && !lineCarry.trimStart().startsWith("|")) {
        output += tableBuffer.length >= 2
          ? prettifyAndWrapTable(tableBuffer)
          : tableBuffer.join("");
        tableBuffer = [];
        output += lineCarry;
        lineCarry = "";
      }
    }

    return output;
  }

  /** Flush any content remaining in the table buffer at end-of-stream. */
  function flushRemainingTableBuffer(): string {
    let output = "";
    if (lineCarry) {
      if (lineCarry.trimStart().startsWith("|")) {
        tableBuffer.push(lineCarry);
      } else {
        if (tableBuffer.length > 0) {
          output += tableBuffer.length >= 2
            ? prettifyAndWrapTable(tableBuffer)
            : tableBuffer.join("");
          tableBuffer = [];
        }
        output += lineCarry;
      }
      lineCarry = "";
    }
    if (tableBuffer.length > 0) {
      output += tableBuffer.length >= 2
        ? prettifyAndWrapTable(tableBuffer)
        : tableBuffer.join("");
      tableBuffer = [];
    }
    return output;
  }

  function addUsage(usage: any) {
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    aggregateUsage.inputTokens += inputTokens;
    aggregateUsage.outputTokens += outputTokens;
    aggregateUsage.totalTokens += inputTokens + outputTokens;

    if (usage?.inputTokenDetails) {
      aggregateUsage.inputTokenDetails ??= {};
      aggregateUsage.inputTokenDetails.noCacheTokens =
        (aggregateUsage.inputTokenDetails.noCacheTokens ?? 0) + (usage.inputTokenDetails.noCacheTokens ?? 0);
      aggregateUsage.inputTokenDetails.cacheReadTokens =
        (aggregateUsage.inputTokenDetails.cacheReadTokens ?? 0) + (usage.inputTokenDetails.cacheReadTokens ?? 0);
      aggregateUsage.inputTokenDetails.cacheWriteTokens =
        (aggregateUsage.inputTokenDetails.cacheWriteTokens ?? 0) + (usage.inputTokenDetails.cacheWriteTokens ?? 0);
    }

    if (usage?.outputTokenDetails) {
      aggregateUsage.outputTokenDetails ??= {};
      aggregateUsage.outputTokenDetails.textTokens =
        (aggregateUsage.outputTokenDetails.textTokens ?? 0) + (usage.outputTokenDetails.textTokens ?? 0);
      aggregateUsage.outputTokenDetails.reasoningTokens =
        (aggregateUsage.outputTokenDetails.reasoningTokens ?? 0) + (usage.outputTokenDetails.reasoningTokens ?? 0);
    }
  }

  async function appendTextDelta(text: string): Promise<void> {
    if (!text) return;
    // Age-based split happens at the delta boundary, before any append.
    await splitForStreamAge();
    accumulatedText += text;
    currentSegmentTextLength += text.length;
    let remaining = processChunkForTables(text);
    if (!remaining) return;

    while (remaining) {
      if (streamingFailed) break;

      if (continuationCount >= MAX_CONTINUATIONS) {
        currentStreamLength += remaining.length;
        await tryStreamAppend(asAppendPayload({ markdown_text: remaining }));
        if (streamingFailed) {
          fallbackStartIdx = streamedRawIdx;
        }
        break;
      }

      const breakIdx = findContinuationBreak(remaining, currentStreamLength);

      if (breakIdx < 0) {
        currentStreamLength += remaining.length;
        await tryStreamAppend(asAppendPayload({ markdown_text: remaining }));
        if (streamingFailed) {
          fallbackStartIdx = streamedRawIdx;
        }
        break;
      }

      const before = remaining.slice(0, breakIdx);
      remaining = remaining.slice(breakIdx);

      if (before) {
        currentStreamLength += before.length;
        await tryStreamAppend(asAppendPayload({ markdown_text: before }));
      }

      if (streamingFailed) {
        fallbackStartIdx = streamedRawIdx;
        break;
      }

      if (!remaining) break;

      if (await splitToNewStream()) {
        // Split succeeded, currentStreamLength reset, loop continues.
      } else if (streamingFailed) {
        fallbackStartIdx = streamedRawIdx;
        break;
      } else {
        // Max continuations reached, stream still active — flush remaining.
        currentStreamLength += remaining.length;
        await tryStreamAppend(asAppendPayload({ markdown_text: remaining }));
        if (streamingFailed) {
          fallbackStartIdx = streamedRawIdx;
        }
        break;
      }
    }

    if (!streamingFailed) {
      streamedRawIdx = accumulatedText.length;
    }
  }

  async function splitToNewStream(reason: ContinuationReason = "length"): Promise<boolean> {
    if (streamingFailed || continuationCount >= MAX_CONTINUATIONS) {
      if (continuationCount >= MAX_CONTINUATIONS) {
        logger.warn("Max continuation messages reached", { continuationCount });
      }
      return false;
    }

    logger.info("Splitting stream for continuation message", {
      currentStreamLength,
      totalAccumulated: accumulatedText.length,
      continuationCount: continuationCount + 1,
      reason,
    });

    await logEmptyContinuationSegmentIfNeeded({
      segmentEnd: "split",
    });

    // Close out dangling in-progress tool cards on the old stream before
    // abandoning it (age splits can happen while tools are still pending).
    if (reason === "long_tool" || (reason === "stream_age" && pendingToolInputs.size > 0)) {
      await appendStreamTombstone();
    }

    try {
      await streamer.stop();
    } catch (stopErr: any) {
      logger.warn("Failed to stop stream for continuation", {
        error: stopErr?.message,
      });
    }

    try {
      streamer = slackClient.chatStream(streamParams);
      streamStartedAt = Date.now();
      currentStreamLength = 0;
      streamTombstoneSent = false;
      continuationCount++;
      currentSegmentIndex = continuationCount;
      currentSegmentTextLength = 0;
      currentSegmentToolRecordStart = toolCallRecords.length;
      currentSegmentContinuationReason = reason;
      return true;
    } catch (startErr: any) {
      logger.warn(
        "Failed to start continuation stream, falling back to postMessage",
        { error: startErr?.message },
      );
      streamingFailed = true;
      return false;
    }
  }

  function startLongToolSplitTimer() {
    if (streamingFailed || longToolSplitTimer || pendingToolInputs.size === 0) return;
    longToolSplitTimer = setTimeout(() => {
      longToolSplitTimer = null;
      void splitLongRunningToolStream();
    }, LONG_TOOL_SPLIT_MS);
  }

  async function splitLongRunningToolStream(): Promise<void> {
    if (longToolSplitInFlight || streamingFailed || pendingToolInputs.size === 0) return;
    longToolSplitInFlight = true;
    try {
      logger.info("Long-running tool still active; splitting Slack stream", {
        channelId,
        pendingToolCount: pendingToolInputs.size,
        thresholdMs: LONG_TOOL_SPLIT_MS,
      });
      if (!(await splitToNewStream("long_tool")) && streamingFailed) {
        fallbackStartIdx = accumulatedText.length;
      }
    } finally {
      longToolSplitInFlight = false;
      if (!streamingFailed && pendingToolInputs.size > 0) {
        startLongToolSplitTimer();
      }
    }
  }

  function streamAgeExceeded(): boolean {
    return (
      !streamingFailed &&
      streamer != null &&
      continuationCount < MAX_CONTINUATIONS &&
      Date.now() - streamStartedAt >= STREAM_MAX_AGE_MS
    );
  }

  /**
   * Split to a fresh Slack stream when the current one is approaching the
   * ~3-minute total stream lifetime cap (see STREAM_MAX_AGE_MS). Independent
   * of pendingToolInputs — sequential short tools never trigger the
   * LONG_TOOL_SPLIT_MS mechanism but still age the stream past the cap.
   * Must only be called at safe boundaries (between deltas / after tool
   * results), never mid-append.
   */
  async function splitForStreamAge(): Promise<void> {
    if (!streamAgeExceeded()) return;
    logger.info("Slack stream exceeded max age; splitting to a fresh stream", {
      channelId,
      streamAgeMs: Date.now() - streamStartedAt,
      thresholdMs: STREAM_MAX_AGE_MS,
      pendingToolCount: pendingToolInputs.size,
      toolCallCount: toolCallRecords.length,
    });
    if (!(await splitToNewStream("stream_age")) && streamingFailed) {
      fallbackStartIdx = accumulatedText.length;
    }
  }

  async function getFinishReason(result: Awaited<ReturnType<typeof agent.stream>>): Promise<unknown> {
    try {
      return (result as any).finishReason
        ? await (result as any).finishReason
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function getFinalResultText(result: Awaited<ReturnType<typeof agent.stream>>): Promise<string> {
    try {
      const text = (result as any).text ? await (result as any).text : "";
      return typeof text === "string" ? text : "";
    } catch {
      return "";
    }
  }

  async function buildRelaunchCallOptions(
    result: Awaited<ReturnType<typeof agent.stream>>,
  ): Promise<Record<string, any>> {
    let responseMessages: ModelMessage[] = [];
    try {
      const response = await result.response;
      if (Array.isArray(response?.messages)) {
        responseMessages = response.messages as ModelMessage[];
      }
    } catch {
      // If response messages are unavailable, relaunch with the user turn and
      // the synthetic continuation rather than dropping the recovery entirely.
    }

    return {
      ...baseStreamCallOptions,
      messages: [
        initialUserMessage,
        ...responseMessages,
        { role: "user", content: EMPTY_COMPLETION_RELAUNCH_PROMPT } satisfies ModelMessage,
      ],
    };
  }

  try {
    // No mid-stream status update here: agents.sessions.setStatus only
    // accepts the enum "suspended"|"processing"|"active"|"closed" — the
    // pipeline already set "processing" at turn start and free-text phases
    // like "Thinking deeply..." are not expressible under agent_view.
    let currentStreamCallOptions = streamCallOptions;
    while (true) {
      supersededDuringStream = false;
      const result = await agent.stream(currentStreamCallOptions as any);
      latestResult = result;
      stepsPromises.push(result.steps);

      for await (const chunk of result.stream) {
        resetTimer();

        switch (chunk.type) {
        case "text-delta": {
          await appendTextDelta(chunk.text);
          break;
        }

        case "tool-input-start": {
          // The gateway can emit this event with `id` instead of `toolCallId`
          // (seen in production 2026-08-27) — accept both.
          const toolCallId = (chunk as any).toolCallId ?? (chunk as any).id;
          const toolName = (chunk as any).toolName;
          if (typeof toolCallId !== "string" || typeof toolName !== "string") {
            break;
          }
          if (optimisticToolCards.has(toolCallId)) {
            break;
          }

          const slackMeta = getSlackMeta(tools[toolName]);
          const title = slackMeta?.status ?? "Working on it...";
          optimisticToolCards.set(toolCallId, { title });
          const toolInputStartPayload = asAppendPayload({
            chunks: [toTaskUpdateChunk({
              id: toolCallId,
              title,
              status: "in_progress",
            })],
          });
          currentStreamLength += estimateAppendSize(toolInputStartPayload);
          if (!streamingFailed) {
            await tryStreamAppend(toolInputStartPayload);
            if (streamingFailed) {
              fallbackStartIdx = accumulatedText.length;
            }
          }
          break;
        }

        case "tool-call": {
          // Flush any pending table buffer before tool cards
          if ((tableBuffer.length > 0 || lineCarry) && !streamingFailed) {
            const preToolFlush = flushRemainingTableBuffer();
            if (preToolFlush) {
              currentStreamLength += preToolFlush.length;
              await tryStreamAppend(asAppendPayload({ markdown_text: preToolFlush }));
            }
            if (streamingFailed) {
              fallbackStartIdx = streamedRawIdx;
            } else {
              streamedRawIdx = accumulatedText.length;
            }
          }

          const slackMeta = getSlackMeta(tools[chunk.toolName]);
          const title = slackMeta?.status ?? "Working on it...";
          const inputArgs = (chunk as any).input ?? {};
          let details: string | undefined;
          try { details = slackMeta?.detail?.(inputArgs); } catch { /* partial input args — safe to ignore */ }
          const toolCallPayload = asAppendPayload({
            chunks: [toTaskUpdateChunk({
              id: chunk.toolCallId,
              title,
              status: "in_progress",
              ...(details && { details }),
            })],
          });
          currentStreamLength += estimateAppendSize(toolCallPayload);
          if (!streamingFailed) {
            await tryStreamAppend(toolCallPayload);
            if (streamingFailed) {
              fallbackStartIdx = accumulatedText.length;
            }
          }

          pendingToolInputs.set(chunk.toolCallId, {
            name: chunk.toolName,
            input: truncateToBytes(JSON.stringify(inputArgs), 1500),
          });
          optimisticToolCards.delete(chunk.toolCallId);
          startLongToolSplitTimer();

          // Keep resetting inactivity timer during long tool execution;
          // each tick also re-checks the invocation lock so a Stop press
          // mid-tool aborts promptly (issue #1355).
          if (toolKeepAlive) clearInterval(toolKeepAlive);
          toolKeepAlive = setInterval(() => {
            resetTimer();
            void abortIfSuperseded();
          }, 60_000);

          // Keep Slack stream alive during long tool execution (~30s idle timeout)
          if (!streamingFailed && streamKeepAlive == null) {
            streamKeepAlive = setInterval(async () => {
              if (streamingFailed) {
                clearInterval(streamKeepAlive!);
                streamKeepAlive = null;
                return;
              }
              await tryStreamAppend(asAppendPayload({ markdown_text: " " }));
            }, 20_000);
          }
          break;
        }

        case "tool-result": {
          const resultSlackMeta = getSlackMeta(tools[chunk.toolName]);
          const title = resultSlackMeta?.status ?? "Done";
          const output = chunk.output;
          const isError = output && typeof output === "object" &&
            "ok" in output && output.ok === false;

          // Capture native Slack blocks from draw_table/draw_chart/
          // raise_alert/draw_cards tools.
          if (
            output && typeof output === "object" &&
            TABLE_BLOCK_KEY in output && output[TABLE_BLOCK_KEY]
          ) {
            pendingNativeBlocks = [output[TABLE_BLOCK_KEY] as Record<string, any>];
            pendingNativeBlockToolCallIds = [chunk.toolCallId];
          } else if (
            output && typeof output === "object" &&
            CHART_BLOCK_KEY in output && output[CHART_BLOCK_KEY]
          ) {
            pendingNativeBlocks = [output[CHART_BLOCK_KEY] as Record<string, any>];
            pendingNativeBlockToolCallIds = [chunk.toolCallId];
          } else if (
            output && typeof output === "object" &&
            ALERT_BLOCK_KEY in output && output[ALERT_BLOCK_KEY]
          ) {
            pendingNativeBlocks = [output[ALERT_BLOCK_KEY] as Record<string, any>];
            pendingNativeBlockToolCallIds = [chunk.toolCallId];
          } else if (
            output && typeof output === "object" &&
            CARD_BLOCK_KEY in output && Array.isArray(output[CARD_BLOCK_KEY]) &&
            (output[CARD_BLOCK_KEY] as unknown[]).length > 0
          ) {
            pendingNativeBlocks = output[CARD_BLOCK_KEY] as Record<string, any>[];
            pendingNativeBlockToolCallIds = [chunk.toolCallId];
          }

          if (pendingNativeBlocks.length > 0) {
            if (!streamingFailed) {
              const streamedNativeBlock = await tryStreamAppend(asAppendPayload({
                chunks: [toBlocksChunk(pendingNativeBlocks)],
              }));
              if (streamedNativeBlock) {
                logger.info("NativeBlockDelivered", {
                  toolCallIds: pendingNativeBlockToolCallIds,
                  path: "stream_append",
                });
                pendingNativeBlocks = [];
                pendingNativeBlockToolCallIds = [];
              }
            }
          }

          const outputAny = output as any;
          let taskOutput: string | undefined;
          try { taskOutput = resultSlackMeta?.output?.(output); } catch { /* safe to ignore — display-only */ }
          taskOutput ??= (isError && outputAny.error ? String(outputAny.error) : undefined);
          const toolResultPayload = asAppendPayload({
            chunks: [toTaskUpdateChunk({
              id: chunk.toolCallId,
              title,
              status: isError ? "error" : "complete",
              ...(taskOutput && { output: taskOutput }),
            })],
          });
          currentStreamLength += estimateAppendSize(toolResultPayload);
          if (!streamingFailed) {
            await tryStreamAppend(toolResultPayload);
            if (streamingFailed) {
              fallbackStartIdx = accumulatedText.length;
            }
          }

          const pending = pendingToolInputs.get(chunk.toolCallId);
          toolCallRecords.push({
            name: chunk.toolName,
            input: pending?.input ?? "{}",
            output: serializeToolOutput(chunk.toolName, output),
            is_error: !!isError,
            rawOutput: output,
          });
          if (
            chunk.toolName === "run_command_detached" &&
            !isError &&
            getDetachedCommandSuspendState()
          ) {
            turnSuspendedByDetachedCommand = true;
          }
          pendingToolInputs.delete(chunk.toolCallId);
          optimisticToolCards.delete(chunk.toolCallId);

          if (pendingToolInputs.size === 0 && toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }
          if (pendingToolInputs.size === 0 && streamKeepAlive) { clearInterval(streamKeepAlive); streamKeepAlive = null; }
          if (pendingToolInputs.size === 0) clearLongToolSplitTimer();
          resetTimer();

          if (pendingToolInputs.size === 0 && currentStreamLength > STREAM_THRESHOLD_NEWLINE && !streamingFailed) {
            if (!(await splitToNewStream()) && streamingFailed) {
              fallbackStartIdx = accumulatedText.length;
            }
          }
          await splitForStreamAge();
          break;
        }

        case "tool-error": {
          const errToolName = (chunk as any).toolName;
          const errToolCallId = (chunk as any).toolCallId;
          const errSlackMeta = getSlackMeta(tools[errToolName]);
          const title = errSlackMeta?.status ?? "Failed";
          const err = (chunk as any).error;
          const errorMsg = err instanceof Error ? err.message : String(err);
          const toolErrorPayload = asAppendPayload({
            chunks: [toTaskUpdateChunk({
              id: errToolCallId,
              title,
              status: "error",
              output: truncate(errorMsg, 200),
            })],
          });
          currentStreamLength += estimateAppendSize(toolErrorPayload);
          if (!streamingFailed) {
            await tryStreamAppend(toolErrorPayload);
            if (streamingFailed) {
              fallbackStartIdx = accumulatedText.length;
            }
          }

          const pending = pendingToolInputs.get(errToolCallId);
          toolCallRecords.push({
            name: errToolName || "unknown",
            input: pending?.input ?? "{}",
            output: truncateToBytes(JSON.stringify({ error: errorMsg }), 1500),
            is_error: true,
          });
          pendingToolInputs.delete(errToolCallId);
          optimisticToolCards.delete(errToolCallId);

          if (pendingToolInputs.size === 0 && toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }
          if (pendingToolInputs.size === 0 && streamKeepAlive) { clearInterval(streamKeepAlive); streamKeepAlive = null; }
          if (pendingToolInputs.size === 0) clearLongToolSplitTimer();
          resetTimer();

          if (pendingToolInputs.size === 0 && currentStreamLength > STREAM_THRESHOLD_NEWLINE && !streamingFailed) {
            if (!(await splitToNewStream()) && streamingFailed) {
              fallbackStartIdx = accumulatedText.length;
            }
          }
          await splitForStreamAge();
          break;
        }
        }
      }

      // Flush any remaining table buffer content before deciding whether the
      // completed attempt produced user-visible text.
      const finalTableFlush = flushRemainingTableBuffer();
      if (finalTableFlush && !streamingFailed) {
        currentStreamLength += finalTableFlush.length;
        await tryStreamAppend(asAppendPayload({ markdown_text: finalTableFlush }));
        if (streamingFailed) {
          fallbackStartIdx = streamedRawIdx;
        }
      }

      const finishReason = await getFinishReason(result);

      await logEmptyContinuationSegmentIfNeeded({
        segmentEnd: "final",
        finishReason,
      });

      if (supersededDuringStream) {
        throw new InvocationSupersededError(invocationId);
      }

      if (accumulatedText.length === 0) {
        const finalResultText = await getFinalResultText(result);
        if (finalResultText.length > 0) {
          logger.warn("Recovered empty streamed response from final result.text", {
            channelId,
            recoveredLength: finalResultText.length,
            finishReason,
          });
          await appendTextDelta(finalResultText);
          const recoveredTableFlush = flushRemainingTableBuffer();
          if (recoveredTableFlush && !streamingFailed) {
            currentStreamLength += recoveredTableFlush.length;
            await tryStreamAppend(asAppendPayload({ markdown_text: recoveredTableFlush }));
            if (streamingFailed) {
              fallbackStartIdx = streamedRawIdx;
            }
          }
        }
      }

      try {
        addUsage(await result.usage);
      } catch {
        // Preserve the response path even if usage metadata is unavailable.
      }

      if (accumulatedText.length === 0 && toolCallRecords.length > 0) {
        const toolErrorCount = toolCallRecords.filter((record) => record.is_error).length;
        const hasUsefulToolResults = toolCallRecords.some((record) => !record.is_error);
        const canRelaunch =
          hasUsefulToolResults &&
          !turnSuspendedByDetachedCommand &&
          finishReason !== "tool-calls" &&
          emptyCompletionRelaunchCount < 1;

        if (canRelaunch) {
          emptyCompletionRelaunchCount++;
          logError({
            errorName: "EmptyCompletionRelaunched",
            errorMessage: "Stream completed without output after useful tool calls; relaunching once",
            errorCode: "empty_completion_relaunched",
            channelId,
            context: {
              toolCallCount: toolCallRecords.length,
              toolErrorCount,
              finishReason,
              relaunchCount: emptyCompletionRelaunchCount,
            },
          });
          currentStreamCallOptions = await buildRelaunchCallOptions(result);
          continue;
        }

        if (turnSuspendedByDetachedCommand) {
          const suspendFallbackText =
            "Started the detached command. I'll continue when it finishes.";
          logger.warn("Detached command suspend turn completed without text; adding fallback", {
            channelId,
            toolCallCount: toolCallRecords.length,
          });
          await appendTextDelta(suspendFallbackText);
        } else {
          logError({
            errorName: "EmptyCompletion",
            errorMessage: "Stream completed without usable output after tool calls",
            errorCode: "empty_completion_after_tools",
            channelId,
            context: {
              toolCallCount: toolCallRecords.length,
              toolErrorCount,
              finishReason,
              relaunchCount: emptyCompletionRelaunchCount,
            },
          });

          streamingFailed = true;
          emptyCompletionDetected = true;

          if (streamer) {
            try {
              await streamer.stop({
                chunks: [toChunkMarkdownText("\n\n_...(no output generated — see Aura logs)_")],
              });
            } catch {
              // Stream may already be unrecoverable.
            }
          }
        }
      }

      break;
    }

    // ── Finalize ──────────────────────────────────────────────────────────
    clearTimeout(inactivityTimer);
    if (toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }
    if (streamKeepAlive) { clearInterval(streamKeepAlive); streamKeepAlive = null; }
    clearLongToolSplitTimer();

    const llmMs = Date.now() - start;
    const finalText = accumulatedText;
    const inputTokens = aggregateUsage.inputTokens;
    const outputTokens = aggregateUsage.outputTokens;
    const totalTokens = aggregateUsage.totalTokens;

    if (streamingFailed) {
      // Stop the current streamer to avoid leaving an orphaned stream on Slack
      if (streamer && !emptyCompletionDetected) {
        try { await streamer.stop(); } catch { /* stream may already be broken */ }
      }

      // Fallback: post the unsent portion via safePostMessage.
      // If a continuation split partially succeeded, only post text that
      // wasn't already streamed (fallbackStartIdx marks the boundary).
      // After a Stop press nothing further is delivered — the user asked for
      // silence, not a bulk dump of what they stopped.
      const unsentText = stoppedByUser
        ? ""
        : fallbackStartIdx > 0
          ? finalText.slice(fallbackStartIdx)
          : finalText;
      const blocks: any[] = [];
      const formattedUnsent = unsentText ? formatForSlack(unsentText) : "";
      // Issue #1121: when the stream died after everything visible had
      // already been streamed (pure tool-call tail), the unsent buffer is
      // empty and the fallback would post an effectively empty block list.
      // Post a short stub instead so the user knows the turn was cut short.
      //
      // Stop press (issue #1355): when a Slack streaming bubble exists,
      // Slack halted it and renders its own native grey "(stopped)"
      // indicator (ai_context.result_status = "stopped_by_user") — posting
      // our `_[stopped]_` stub as a NEW message would show the marker twice.
      // The stub survives only when streaming never happened (no bubble, no
      // native indicator); with a live bubble nothing more is delivered.
      const stopRenderedNativelyBySlack = stoppedByUser && streamer != null;
      const interruptedStubText = stoppedByUser
        ? stopRenderedNativelyBySlack ? null : "_[stopped]_"
        : !emptyCompletionDetected && !formattedUnsent && toolCallRecords.length > 0
          ? `_Turn interrupted after ${toolCallRecords.length} tool call${toolCallRecords.length === 1 ? "" : "s"} — rerun?_`
          : null;
      if (formattedUnsent) {
        for (let i = 0; i < formattedUnsent.length; i += 3000) {
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: formattedUnsent.slice(i, i + 3000) },
            expand: true,
          });
        }
      } else if (interruptedStubText) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: interruptedStubText },
          expand: true,
        });
      }
      if (pendingNativeBlocks.length > 0) {
        blocks.push(...pendingNativeBlocks);
      }

      blocks.push({
        type: "context_actions",
        elements: [{
          type: "feedback_buttons",
          action_id: "aura_feedback",
          positive_button: { text: { type: "plain_text", text: "Good" }, value: "positive" },
          negative_button: { text: { type: "plain_text", text: "Bad" }, value: "negative" },
        }],
      });

      const toolMeta = buildToolMetadata(toolCallRecords);
      const fallbackText = emptyCompletionDetected
        ? emptyCompletionFallbackText
        : interruptedStubText ?? (formattedUnsent || "_I processed your request but had nothing to say._");

      if (stopRenderedNativelyBySlack) {
        // Nothing left to deliver: the unsent buffer is suppressed on a Stop
        // press and Slack's own indicator marks the halted bubble.
        logger.info("Stop press rendered natively by Slack — skipping fallback delivery", {
          channelId,
        });
      } else {
        // Issue #1342: skip the fallback post entirely when a newer message has
        // taken over the thread — unwind through the existing supersede path.
        if (!(await isCurrentAtFinalDelivery("post_message_fallback"))) {
          throw new InvocationSupersededError(invocationId);
        }

        try {
          const fallbackResult = await safePostMessage(slackClient, {
            channel: channelId,
            text: fallbackText,
            thread_ts: threadTs,
            blocks,
            ...(toolMeta && { metadata: toolMeta }),
          });

          if (!fallbackResult.ok) {
            flushPendingMessageNotInStreamingStateError(false);
            logger.warn("LLM response lost — channel does not support posting", {
              channelId,
              rawLength: finalText.length,
              usage: { inputTokens, outputTokens, totalTokens },
            });
            logChannelTypeUnsupportedFallbackFailure("safePostMessage_returned_not_ok");
          } else {
            flushPendingMessageNotInStreamingStateError(true);
            pendingChannelTypeUnsupportedFallback = null;
            if (pendingNativeBlocks.length > 0) {
              logger.info("NativeBlockDelivered", {
                toolCallIds: pendingNativeBlockToolCallIds,
                path: "post_message_fallback",
              });
              pendingNativeBlocks = [];
              pendingNativeBlockToolCallIds = [];
            }
            logger.info(`LLM completed in ${llmMs}ms (fallback postMessage)`, {
              rawLength: finalText.length,
              channelId,
              usage: { inputTokens, outputTokens, totalTokens },
            });
          }
        } catch (fallbackErr: any) {
          flushPendingMessageNotInStreamingStateError(false);
          logger.error("Fallback safePostMessage also failed — posting plain text", {
            channelId,
            error: fallbackErr?.message || String(fallbackErr),
            slackError: fallbackErr?.data?.error,
          });
          try {
            await slackClient.chat.postMessage({
              channel: channelId,
              text: fallbackText || "I generated a response but couldn't deliver it. Please try again.",
              thread_ts: threadTs,
            });
            pendingChannelTypeUnsupportedFallback = null;
          } catch (plainPostErr: any) {
            logChannelTypeUnsupportedFallbackFailure("plain_post_failed", plainPostErr);
            logger.error("All message delivery paths failed", {
              channelId,
              error: plainPostErr?.message || String(plainPostErr),
              slackError: plainPostErr?.data?.error,
            });
          }
        }
      }
    } else {
      // Happy path: finalize the stream on Slack's side.
      // Attach tool I/O metadata (invisible to users) for follow-up context,
      // and inject native table/chart blocks if present.
      const feedbackBlock = {
        type: "context_actions",
        elements: [{
          type: "feedback_buttons",
          action_id: "aura_feedback",
          positive_button: { text: { type: "plain_text", text: "Good" }, value: "positive" },
          negative_button: { text: { type: "plain_text", text: "Bad" }, value: "negative" },
        }],
      };

      const toolMeta = buildToolMetadata(toolCallRecords);
      const stopBlocks: any[] = [];
      if (pendingNativeBlocks.length > 0) stopBlocks.push(...pendingNativeBlocks);
      stopBlocks.push(feedbackBlock);
      const stopArgs: Record<string, any> = { blocks: stopBlocks };
      if (toolMeta) stopArgs.metadata = toolMeta;

      // Issue #1342: do NOT finalize the stream with the answer when a newer
      // message has taken over the thread — unwind through the existing
      // supersede path (streamer.stop with interruption note, telemetry).
      if (!(await isCurrentAtFinalDelivery("stream_stop"))) {
        throw new InvocationSupersededError(invocationId);
      }

      try {
        await streamer.stop(stopArgs);
        if (pendingNativeBlocks.length > 0) {
          logger.info("NativeBlockDelivered", {
            toolCallIds: pendingNativeBlockToolCallIds,
            path: "stop_blocks",
          });
          pendingNativeBlocks = [];
          pendingNativeBlockToolCallIds = [];
        }
      } catch (stopErr: any) {
        if (isInvalidBlocks(stopErr) || isInvalidArguments(stopErr)) {
          // Slack rejects a block payload at stop with either `invalid_blocks`
          // or `invalid_arguments` depending on which validation layer trips
          // (same asymmetry as the append path). Both are recoverable: retry
          // the stop without blocks, then deliver the native block via
          // chat.postMessage.
          const stopErrCode = stopErr?.data?.error ||
            (isInvalidArguments(stopErr) ? "invalid_arguments" : "invalid_blocks");
          logger.warn("streamer.stop() rejected blocks, retrying without them", {
            channelId,
            slackError: stopErr?.data?.error,
            blockTypes: stopBlocks.map((b: any) => b.type),
          });
          logError({
            errorName: isInvalidArguments(stopErr)
              ? "StreamStopInvalidArguments"
              : "StreamStopInvalidBlocks",
            errorMessage: stopErr?.message || `${stopErrCode} on streamer.stop()`,
            errorCode: stopErrCode,
            channelId,
            context: { phase: "stop", blockTypes: stopBlocks.map((b: any) => b.type) },
          });
          try {
            await streamer.stop();
          } catch {
            // Stream may already be finalized
          }
          // Deliver the native blocks via chat.postMessage as a follow-up
          // when the stream rejected them (e.g. MPIMs, some channel types).
          if (pendingNativeBlocks.length > 0) {
            try {
              await slackClient.chat.postMessage({
                channel: channelId,
                text: fallbackTextForNativeBlock(pendingNativeBlocks[0]),
                blocks: pendingNativeBlocks as any,
                thread_ts: threadTs,
              });
              logger.info("NativeBlockDelivered", {
                toolCallIds: pendingNativeBlockToolCallIds,
                path: "post_message_fallback",
              });
              pendingNativeBlocks = [];
              pendingNativeBlockToolCallIds = [];
            } catch (nativeBlockPostErr: any) {
              logger.warn("Failed to post native block via chat.postMessage fallback", {
                channelId,
                error: nativeBlockPostErr?.message,
              });
              logError({
                errorName: "NativeBlockDropped",
                errorMessage: nativeBlockPostErr?.message ||
                  "chat.postMessage fallback failed for native block",
                errorCode: "native_block_dropped",
                channelId,
                context: {
                  toolCallIds: pendingNativeBlockToolCallIds,
                  path: "post_message_fallback",
                  error: nativeBlockPostErr?.message || String(nativeBlockPostErr),
                },
              });
              pendingNativeBlocks = [];
              pendingNativeBlockToolCallIds = [];
            }
          }
        } else if (isMsgTooLong(stopErr)) {
          logger.warn("streamer.stop() returned msg_too_long, finalizing without payload", {
            channelId,
            currentStreamLength,
          });
          logError({
            errorName: "StreamStopMsgTooLong",
            errorMessage: stopErr?.message || "msg_too_long on streamer.stop()",
            errorCode: "msg_too_long",
            channelId,
            context: { currentStreamLength },
          });
          try { await streamer.stop(); } catch { /* already finalized */ }
          if (pendingNativeBlocks.length > 0) {
            try {
              await slackClient.chat.postMessage({
                channel: channelId,
                text: fallbackTextForNativeBlock(pendingNativeBlocks[0]),
                blocks: pendingNativeBlocks as any,
                thread_ts: threadTs,
              });
              logger.info("NativeBlockDelivered", {
                toolCallIds: pendingNativeBlockToolCallIds,
                path: "post_message_fallback",
              });
              pendingNativeBlocks = [];
              pendingNativeBlockToolCallIds = [];
            } catch (nativeBlockPostErr: any) {
              logger.warn("Failed to post native block via chat.postMessage fallback", {
                channelId,
                error: nativeBlockPostErr?.message,
              });
              logError({
                errorName: "NativeBlockDropped",
                errorMessage: nativeBlockPostErr?.message ||
                  "chat.postMessage fallback failed for native block",
                errorCode: "native_block_dropped",
                channelId,
                context: {
                  toolCallIds: pendingNativeBlockToolCallIds,
                  path: "post_message_fallback",
                  error: nativeBlockPostErr?.message || String(nativeBlockPostErr),
                },
              });
              pendingNativeBlocks = [];
              pendingNativeBlockToolCallIds = [];
            }
          }
        } else if (isChannelTypeNotSupported(stopErr)) {
          streamingUnsupportedChannels.add(channelId);
          logger.warn("streamer.stop() hit channel_type_not_supported, finalizing without payload", {
            channelId,
          });
          try { await streamer.stop(); } catch { /* already finalized */ }
          if (pendingNativeBlocks.length > 0) {
            try {
              await slackClient.chat.postMessage({
                channel: channelId,
                text: fallbackTextForNativeBlock(pendingNativeBlocks[0]),
                blocks: pendingNativeBlocks as any,
                thread_ts: threadTs,
              });
              logger.info("NativeBlockDelivered", {
                toolCallIds: pendingNativeBlockToolCallIds,
                path: "post_message_fallback",
              });
              pendingNativeBlocks = [];
              pendingNativeBlockToolCallIds = [];
            } catch (nativeBlockPostErr: any) {
              logger.warn("Failed to post native block via chat.postMessage fallback", {
                channelId,
                error: nativeBlockPostErr?.message,
              });
              logError({
                errorName: "NativeBlockDropped",
                errorMessage: nativeBlockPostErr?.message ||
                  "chat.postMessage fallback failed for native block",
                errorCode: "native_block_dropped",
                channelId,
                context: {
                  toolCallIds: pendingNativeBlockToolCallIds,
                  path: "post_message_fallback",
                  error: nativeBlockPostErr?.message || String(nativeBlockPostErr),
                },
              });
              pendingNativeBlocks = [];
              pendingNativeBlockToolCallIds = [];
            }
          }
        } else {
          throw stopErr;
        }
      }

      logger.info(`LLM stream completed in ${llmMs}ms`, {
        rawLength: finalText.length,
        usage: { inputTokens, outputTokens, totalTokens },
      });
    }

    // Issue #1180: a native block that survived every delivery attempt was
    // silently dropped — record it so the gap is visible in error_events.
    if (pendingNativeBlocks.length > 0) {
      logError({
        errorName: "NativeBlockDropped",
        errorMessage: "Turn finished with an undelivered native table/chart block",
        errorCode: "native_block_dropped",
        channelId,
        context: {
          toolCallIds: pendingNativeBlockToolCallIds,
          path: "turn_end",
        },
      });
      pendingNativeBlocks = [];
      pendingNativeBlockToolCallIds = [];
    }

    await persistDeferredToolCache();

    turnMarkerStatus = "completed";
    return {
      raw: finalText,
      alreadyPosted: true,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens,
        inputTokenDetails: aggregateUsage.inputTokenDetails,
        outputTokenDetails: aggregateUsage.outputTokenDetails,
      },
      toolCalls: toolCallRecords,
      modelId,
      stepsPromise: stepsPromises.length > 1
        ? Promise.all(stepsPromises).then((steps) => steps.flat())
        : latestResult?.steps,
      stepModelIds: getStepModelIds(),
      compactionTotals: getCompactionTotals?.(),
    };
  } catch (error: any) {
    clearTimeout(inactivityTimer);
    if (toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }
    if (streamKeepAlive) { clearInterval(streamKeepAlive); streamKeepAlive = null; }
    clearLongToolSplitTimer();

    // A mid-tool supersede abort (issue #1355) surfaces from the SDK as an
    // AbortError / AI_NoOutputGeneratedError, not as the error prepareStep
    // throws at step boundaries. Normalize it so the superseded unwind below
    // (and its `_[stopped]_` note) handles it instead of the abort tombstone.
    if (midToolSupersedeAbort && !(error instanceof InvocationSupersededError)) {
      error = new InvocationSupersededError(invocationId);
    }

    if (error instanceof InvocationSupersededError) {
      logger.info("Stream interrupted — invocation superseded", {
        invocationId: error.invocationId,
        channelId,
      });

      // Observability only — supersede recovery semantics (PR #1000) are
      // unchanged. Without this row, 0-token hangs that get superseded by a
      // user follow-up never appear in error_events (issue #1121).
      logError({
        errorName: "InvocationSupersededDuringStream",
        errorMessage: error?.message || "Invocation superseded while streaming",
        errorCode: "superseded_while_streaming",
        channelId,
        context: {
          invocationId: error.invocationId,
          abortReason: lastAbortReason,
          accumulatedTextLength: accumulatedText.length,
          toolCallCount: toolCallRecords.length,
          streamAgeMs: Date.now() - streamStartedAt,
        },
      });

      // "stopped" = the user pressed Stop (agent_session_stopped); otherwise a
      // newer message claimed the lock. Slack already halted the stream on a
      // Stop press, so stop() may reject — best effort.
      const supersedeReason = await getSupersedeReason(channelId, threadTs);
      const interruptedNote = interruptionNote(supersedeReason);
      if (streamer && !streamingFailed) {
        try {
          // On a Stop press Slack renders its own native grey "(stopped)"
          // indicator on the halted bubble (ai_context.result_status =
          // "stopped_by_user") — appending our `_[stopped]_` too would show
          // the marker twice (issue #1355). Only "newer_message" keeps the
          // markdown note; Slack has no native indicator for that.
          const closingChunks = [
            ...buildOptimisticToolErrorChunks(
              supersedeReason === "stopped" ? "Stopped by user" : "Interrupted by a newer message",
            ),
            ...(supersedeReason !== "stopped"
              ? [toChunkMarkdownText(`\n\n${interruptedNote}`)]
              : []),
          ];
          await streamer.stop(closingChunks.length > 0 ? { chunks: closingChunks } : undefined);
          optimisticToolCards.clear();
        } catch {
          // Stream may already be closed
        }
      }

      await persistDeferredToolCache();

      turnMarkerStatus = "completed";
      return {
        raw: accumulatedText + `\n\n${interruptedNote}`,
        alreadyPosted: true,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        toolCalls: toolCallRecords,
        modelId,
        stepModelIds: getStepModelIds(),
        compactionTotals: getCompactionTotals?.(),
        interrupted: true,
      };
    }

    if (hasFiles && isUnsupportedFileError(error)) {
      logger.warn("LLM call failed due to unsupported file type, retrying without file parts", {
        channelId,
        error: error.message,
      });

      const fileNames = options.files!
        .filter((f) => f.type === "file")
        .map((f) => (f as any).filename || "unknown")
        .join(", ");

      const retryPrompt = fileNames
        ? `${options.userMessage}\n\n[Some attached files could not be processed: ${fileNames}]`
        : options.userMessage;

      const retryAbortController = new AbortController();
      let retryInactivityTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
        logger.warn("LLM retry inactivity timeout (180s), aborting");
        retryAbortController.abort();
      }, 180_000);

      try {
        const { model: retryModel } = await getMainModel();
        const retrySystemMessages = buildCachedSystemMessages(
          options.stablePrefix,
          options.environmentContext,
          options.conversationContext,
          options.dynamicContext,
        );
        const retryResult = streamText({
          model: retryModel,
          instructions: retrySystemMessages,
          prompt: retryPrompt,
          abortSignal: retryAbortController.signal,
          telemetry: aiTelemetry("slack-chat-retry"),
        });
        let retryText = "";

        for await (const chunk of retryResult.stream) {
          clearTimeout(retryInactivityTimer);
          retryInactivityTimer = setTimeout(() => {
            logger.warn("LLM retry inactivity timeout (180s), aborting");
            retryAbortController.abort();
          }, 180_000);

          if (chunk.type === "text-delta") {
            retryText += chunk.text;
            await tryStreamAppend(asAppendPayload({ markdown_text: chunk.text }));
          }
        }

        clearTimeout(retryInactivityTimer);

        const retryUsage = await retryResult.usage;
        const retryInputTokens = retryUsage.inputTokens ?? 0;
        const retryOutputTokens = retryUsage.outputTokens ?? 0;

        if (!streamingFailed) {
          try { if (streamer) await streamer.stop(); } catch { /* already closed */ }
        } else {
          const fallbackText = retryText || "_I processed your request but had nothing to say._";
          await safePostMessage(slackClient, {
            channel: channelId,
            text: fallbackText,
            thread_ts: threadTs,
          });
        }

        await persistDeferredToolCache();

        turnMarkerStatus = "completed";
        return {
          raw: retryText,
          alreadyPosted: true,
          usage: {
            inputTokens: retryInputTokens,
            outputTokens: retryOutputTokens,
            totalTokens: retryInputTokens + retryOutputTokens,
            inputTokenDetails: retryUsage.inputTokenDetails,
            outputTokenDetails: retryUsage.outputTokenDetails,
          },
          toolCalls: toolCallRecords,
          modelId,
        };
      } catch (retryError: any) {
        clearTimeout(retryInactivityTimer);
        logger.error("Retry without files also failed", {
          channelId,
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
        logError({
          errorName: retryError?.name || "RetryError",
          errorMessage: retryError instanceof Error ? retryError.message : String(retryError),
          errorCode: "retry_without_files_failed",
          channelId,
          stackTrace: retryError instanceof Error ? retryError.stack : undefined,
        });
      }
    }

    const isAbortError = error?.name === "AbortError" || error?.code === "ABORT_ERR";
    if (isAbortError) {
      const reason = lastAbortReason || "unknown";
      const tombstone = `_[stream aborted: ${reason}]_`;

      logError({
        errorName: "StreamAborted",
        errorMessage: error?.message || `Stream aborted: ${reason}`,
        errorCode: "stream_aborted_by_watchdog",
        channelId,
        context: {
          reason,
          accumulatedTextLength: accumulatedText.length,
          toolCallCount: toolCallRecords.length,
          segmentIndex: currentSegmentIndex,
        },
        stackTrace: error?.stack,
      });

      if (streamer && !streamingFailed) {
        try {
          await streamer.stop({
            chunks: [
              ...buildOptimisticToolErrorChunks(tombstone),
              toChunkMarkdownText(`\n\n${tombstone}`),
            ],
          });
          optimisticToolCards.clear();
        } catch {
          try {
            await safePostMessage(slackClient, {
              channel: channelId,
              text: tombstone,
              thread_ts: threadTs,
            });
          } catch {
            // Best effort only; preserve the original abort error.
          }
        }
      } else {
        try {
          await safePostMessage(slackClient, {
            channel: channelId,
            text: tombstone,
            thread_ts: threadTs,
          });
        } catch {
          // Best effort only; preserve the original abort error.
        }
      }

      throw error;
    }

    logError({
      errorName: error?.name || "StreamingError",
      errorMessage: error?.message || String(error),
      errorCode: error?.data?.error || error?.code || "streaming_failure",
      channelId,
      context: { hasFiles, accumulatedTextLength: accumulatedText.length },
      stackTrace: error?.stack,
    });

    // If streaming was never established, don't try to stop it
    if (!streamingFailed && streamer) {
      try {
        const errorText = accumulatedText
          ? "\n\n_...interrupted. Something went wrong._"
          : "_Sorry, I got interrupted before I could finish. Try again?_";

        await streamer.stop({
          chunks: [
            ...buildOptimisticToolErrorChunks(error?.message || String(error)),
            toChunkMarkdownText(errorText),
          ],
        });
        optimisticToolCards.clear();
      } catch {
        // Stream may already be closed — nothing we can do
      }
    }

    if (isChannelTypeNotSupported(error) && accumulatedText) {
      streamingUnsupportedChannels.add(channelId);
      try {
        const fallbackResult = await safePostMessage(slackClient, {
          channel: channelId,
          text: formatForSlack(accumulatedText) || accumulatedText,
          thread_ts: threadTs,
        });
        if (fallbackResult.ok) {
          await persistDeferredToolCache();

          turnMarkerStatus = "completed";
          return {
            raw: accumulatedText,
            alreadyPosted: true,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            toolCalls: toolCallRecords,
            modelId,
          };
        }
        logger.warn("LLM response lost — channel does not support posting", {
          channelId,
          rawLength: accumulatedText.length,
        });
      } catch { /* truly cannot post to this channel */ }
    }

    throw error;
  } finally {
    await persistDeferredToolCache();
    cleanupScratchpad(invocationId);
    if (trackTurnMarker) {
      // Fail-soft; a hard kill skips this entirely — that's what the
      // heartbeat watchdog detects.
      await finishTurnMarker(invocationId, turnMarkerStatus);
    }
  }
}
