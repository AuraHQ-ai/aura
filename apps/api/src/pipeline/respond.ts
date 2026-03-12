import { streamText } from "ai";
import type { WebClient } from "@slack/web-api";
import type { FileContentPart } from "../lib/files.js";
import { logger } from "../lib/logger.js";
import { logError } from "../lib/error-logger.js";
import { formatForSlack, prettifyAndWrapTable } from "../lib/format.js";
import { TABLE_BLOCK_KEY } from "../tools/table.js";
import { safePostMessage, isChannelTypeNotSupported, isInvalidBlocks, isMsgTooLong } from "../lib/slack-messaging.js";
import { getSlackMeta } from "../lib/tool.js";
import { createInteractiveAgent } from "../lib/agents.js";
import { getMainModel, buildCachedSystemMessages } from "../lib/ai.js";

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
    case "execute_query": {
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
  /** Stable within a conversation thread (cached per-thread) */
  conversationContext: string;
  /** Dynamic per-call context (time, model, channel) — passed as uncached system message */
  dynamicContext?: string;
  userMessage: string;
  slackClient: WebClient;
  context?: { userId?: string; channelId?: string; threadTs?: string; timezone?: string };
  files?: FileContentPart[];
  channelId: string;
  threadTs?: string;
  /** Slack team ID — required for chatStream in channels */
  teamId?: string;
  /** Slack user ID of the message author — required for chatStream in channels */
  recipientUserId?: string;
  /** Channel type for smart routing (skip streaming on unsupported types) */
  channelType?: import("./context.js").ChannelType;
  /** Whether this is a headless/job execution (skip streaming, go straight to safePostMessage) */
  isHeadless?: boolean;
}

export interface LLMResponse {
  /** The raw LLM output */
  raw: string;
  /** Whether the response was already posted to Slack via streaming */
  alreadyPosted: boolean;
  /** Token usage */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Tool calls executed during this response */
  toolCalls: ToolCallRecord[];
  /** Model ID used for this response */
  modelId?: string;
  /** Promise that resolves to the conversation steps (for persistence) */
  stepsPromise?: PromiseLike<any[]>;
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
  if (payload.markdown_text) return payload.markdown_text.length;
  return JSON.stringify(payload).length;
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

  const streamParams: Record<string, any> = {
    channel: channelId,
    thread_ts: threadTs,
    task_display_mode: "timeline",
  };

  // recipient_team_id and recipient_user_id are required for channels
  if (options.teamId) streamParams.recipient_team_id = options.teamId;
  if (options.recipientUserId) streamParams.recipient_user_id = options.recipientUserId;

  let streamer: any = null;
  if (!skipStreaming) {
    streamer = slackClient.chatStream(streamParams as any);
  }

  // ── Streaming fallback ──────────────────────────────────────────────
  // Some channel types (e.g. Slack List internal channels) don't support
  // chat.startStream. When we detect this, we flip to buffer-only mode
  // and post the final result via chat.postMessage.
  let streamingFailed = skipStreaming;

  async function tryStreamAppend(payload: any): Promise<void> {
    if (streamingFailed) return;
    try {
      await streamer.append(payload);
    } catch (err: any) {
      if (isChannelTypeNotSupported(err)) {
        streamingFailed = true;
        streamingUnsupportedChannels.add(channelId);
        logger.warn(
          "chatStream not supported for this channel, falling back to postMessage",
          { channelId },
        );
        logError({
          errorName: "StreamingUnsupported",
          errorMessage: err?.message || "channel_type_not_supported",
          errorCode: "channel_type_not_supported",
          channelId,
          context: { fallback: "postMessage" },
        });
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
  }

  // ── Inactivity timeout ───────────────────────────────────────────────
  const abortController = new AbortController();
  let inactivityTimer: ReturnType<typeof setTimeout> = undefined as any;

  const resetTimer = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      logger.warn("LLM inactivity timeout (180s), aborting");
      abortController.abort();
    }, 180_000);
  };
  resetTimer();

  // Keepalive interval during long tool calls (e.g. Claude Code via run_command)
  let toolKeepAlive: ReturnType<typeof setInterval> | null = null;

  // Slack stream keepalive — sends minimal payload to prevent ~30s idle timeout
  let streamKeepAlive: ReturnType<typeof setInterval> | null = null;

  // ── Build agent ──────────────────────────────────────────────────────
  const { agent, tools, modelId } = await createInteractiveAgent({
    slackClient: options.slackClient,
    context: options.context,
    stablePrefix: options.stablePrefix,
    conversationContext: options.conversationContext,
    dynamicContext: options.dynamicContext,
  });

  const streamCallOptions: Record<string, any> = {
    abortSignal: abortController.signal,
  };

  if (hasFiles) {
    const content: any[] = [
      { type: "text", text: options.userMessage },
      ...options.files!,
    ];
    streamCallOptions.messages = [{ role: "user", content }];
  } else {
    streamCallOptions.prompt = options.userMessage;
  }

  logger.info("Starting LLM stream", {
    model: modelId || "unknown",
    hasFiles,
    toolCount: Object.keys(tools || {}).length,
    promptLength: options.stablePrefix.length + options.conversationContext.length,
  });

  // ── Stream and send to Slack ────────────────────────────────────────
  let accumulatedText = "";
  let currentStreamLength = 0;
  let fallbackStartIdx = 0;
  let streamedRawIdx = 0;
  let pendingTableBlock: Record<string, any> | null = null;
  const toolCallRecords: ToolCallRecord[] = [];
  const pendingToolInputs = new Map<string, { name: string; input: string }>();
  let continuationCount = 0;
  let tableBuffer: string[] = [];
  let lineCarry = "";

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

  async function splitToNewStream(): Promise<boolean> {
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
    });

    try {
      await streamer.stop();
    } catch (stopErr: any) {
      logger.warn("Failed to stop stream for continuation", {
        error: stopErr?.message,
      });
    }

    try {
      streamer = slackClient.chatStream(streamParams as any);
      currentStreamLength = 0;
      continuationCount++;
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

  try {
    // Signal extended thinking phase to the user via Slack thread status
    try {
      await slackClient.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadTs,
        status: "Thinking deeply...",
      });
    } catch {
      // Non-fatal: scope may not be configured or channel type unsupported
    }

    const result = await agent.stream(streamCallOptions as any);

    for await (const chunk of result.fullStream) {
      resetTimer();

      switch (chunk.type) {
        case "text-delta": {
          accumulatedText += chunk.text;
          let remaining = processChunkForTables(chunk.text);
          if (!remaining) break;

          while (remaining) {
            if (streamingFailed) break;

            if (continuationCount >= MAX_CONTINUATIONS) {
              currentStreamLength += remaining.length;
              await tryStreamAppend({ markdown_text: remaining });
              if (streamingFailed) {
                fallbackStartIdx = streamedRawIdx;
              }
              break;
            }

            const breakIdx = findContinuationBreak(remaining, currentStreamLength);

            if (breakIdx < 0) {
              currentStreamLength += remaining.length;
              await tryStreamAppend({ markdown_text: remaining });
              if (streamingFailed) {
                fallbackStartIdx = streamedRawIdx;
              }
              break;
            }

            const before = remaining.slice(0, breakIdx);
            remaining = remaining.slice(breakIdx);

            if (before) {
              currentStreamLength += before.length;
              await tryStreamAppend({ markdown_text: before });
            }

            if (streamingFailed) {
              fallbackStartIdx = streamedRawIdx;
              break;
            }

            if (!remaining) break;

            if (await splitToNewStream()) {
              // Split succeeded, currentStreamLength reset, loop continues
            } else if (streamingFailed) {
              fallbackStartIdx = streamedRawIdx;
              break;
            } else {
              // Max continuations reached, stream still active — flush remaining
              currentStreamLength += remaining.length;
              await tryStreamAppend({ markdown_text: remaining });
              if (streamingFailed) {
                fallbackStartIdx = streamedRawIdx;
              }
              break;
            }
          }

          if (!streamingFailed) {
            streamedRawIdx = accumulatedText.length;
          }
          break;
        }

        case "tool-call": {
          // Flush any pending table buffer before tool cards
          if ((tableBuffer.length > 0 || lineCarry) && !streamingFailed) {
            const preToolFlush = flushRemainingTableBuffer();
            if (preToolFlush) {
              currentStreamLength += preToolFlush.length;
              await tryStreamAppend({ markdown_text: preToolFlush });
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
          const details = slackMeta?.detail?.(inputArgs);
          const toolCallPayload = {
            chunks: [{
              type: "task_update",
              id: chunk.toolCallId,
              title,
              status: "in_progress",
              ...(details && { details }),
            }],
          };
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

          // Keep resetting inactivity timer during long tool execution
          if (toolKeepAlive) clearInterval(toolKeepAlive);
          toolKeepAlive = setInterval(() => resetTimer(), 60_000);

          // Keep Slack stream alive during long tool execution (~30s idle timeout)
          if (!streamingFailed && streamKeepAlive == null) {
            streamKeepAlive = setInterval(async () => {
              if (streamingFailed) {
                clearInterval(streamKeepAlive!);
                streamKeepAlive = null;
                return;
              }
              await tryStreamAppend({ markdown_text: " " });
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

          // Capture native Slack table block from draw_table tool
          if (
            output && typeof output === "object" &&
            TABLE_BLOCK_KEY in output && output[TABLE_BLOCK_KEY]
          ) {
            pendingTableBlock = output[TABLE_BLOCK_KEY] as Record<string, any>;
          }

          const outputAny = output as any;
          const taskOutput = resultSlackMeta?.output?.(output)
            ?? (isError && outputAny.error ? String(outputAny.error) : undefined);
          const sources = resultSlackMeta?.sources?.(output);

          const toolResultPayload = {
            chunks: [{
              type: "task_update",
              id: chunk.toolCallId,
              title,
              status: isError ? "error" : "complete",
              ...(taskOutput && { output: taskOutput }),
              ...(sources && { sources }),
            }],
          };
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
          pendingToolInputs.delete(chunk.toolCallId);

          if (pendingToolInputs.size === 0 && toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }
          if (pendingToolInputs.size === 0 && streamKeepAlive) { clearInterval(streamKeepAlive); streamKeepAlive = null; }
          resetTimer();

          if (pendingToolInputs.size === 0 && currentStreamLength > STREAM_THRESHOLD_NEWLINE && !streamingFailed) {
            if (!await splitToNewStream() && streamingFailed) {
              fallbackStartIdx = accumulatedText.length;
            }
          }
          break;
        }

        case "tool-error": {
          const errToolName = (chunk as any).toolName;
          const errToolCallId = (chunk as any).toolCallId;
          const errSlackMeta = getSlackMeta(tools[errToolName]);
          const title = errSlackMeta?.status ?? "Failed";
          const err = (chunk as any).error;
          const errorMsg = err instanceof Error ? err.message : String(err);
          const toolErrorPayload = {
            chunks: [{
              type: "task_update",
              id: errToolCallId,
              title,
              status: "error",
              output: truncate(errorMsg, 200),
            }],
          };
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

          if (pendingToolInputs.size === 0 && toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }
          if (pendingToolInputs.size === 0 && streamKeepAlive) { clearInterval(streamKeepAlive); streamKeepAlive = null; }
          resetTimer();

          if (pendingToolInputs.size === 0 && currentStreamLength > STREAM_THRESHOLD_NEWLINE && !streamingFailed) {
            if (!await splitToNewStream() && streamingFailed) {
              fallbackStartIdx = accumulatedText.length;
            }
          }
          break;
        }
      }
    }

    // Flush any remaining table buffer content before finalizing
    const finalTableFlush = flushRemainingTableBuffer();
    if (finalTableFlush && !streamingFailed) {
      currentStreamLength += finalTableFlush.length;
      await tryStreamAppend({ markdown_text: finalTableFlush });
      if (streamingFailed) {
        fallbackStartIdx = streamedRawIdx;
      }
    }

    // ── Finalize ──────────────────────────────────────────────────────────
    clearTimeout(inactivityTimer);
    if (toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }
    if (streamKeepAlive) { clearInterval(streamKeepAlive); streamKeepAlive = null; }

    const llmMs = Date.now() - start;
    const usage = await result.usage;

    const finalText = accumulatedText;

    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;

    if (streamingFailed) {
      // Stop the current streamer to avoid leaving an orphaned stream on Slack
      if (streamer) {
        try { await streamer.stop(); } catch { /* stream may already be broken */ }
      }

      // Fallback: post the unsent portion via safePostMessage.
      // If a continuation split partially succeeded, only post text that
      // wasn't already streamed (fallbackStartIdx marks the boundary).
      const unsentText = fallbackStartIdx > 0
        ? finalText.slice(fallbackStartIdx)
        : finalText;
      const blocks: any[] = [];
      const formattedUnsent = unsentText ? formatForSlack(unsentText) : "";
      if (formattedUnsent) {
        for (let i = 0; i < formattedUnsent.length; i += 3000) {
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: formattedUnsent.slice(i, i + 3000) },
            expand: true,
          });
        }
      }
      if (pendingTableBlock) {
        blocks.push(pendingTableBlock);
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
      const fallbackText = formattedUnsent || "_I processed your request but had nothing to say._";

      try {
        const fallbackResult = await safePostMessage(slackClient, {
          channel: channelId,
          text: fallbackText,
          thread_ts: threadTs,
          blocks,
          ...(toolMeta && { metadata: toolMeta }),
        });

        if (!fallbackResult.ok) {
          logger.warn("LLM response lost — channel does not support posting", {
            channelId,
            rawLength: finalText.length,
            usage: { inputTokens, outputTokens, totalTokens },
          });
        } else {
          logger.info(`LLM completed in ${llmMs}ms (fallback postMessage)`, {
            rawLength: finalText.length,
            channelId,
            usage: { inputTokens, outputTokens, totalTokens },
          });
        }
      } catch (fallbackErr: any) {
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
        } catch {
          logger.error("All message delivery paths failed", { channelId });
        }
      }
    } else {
      // Happy path: finalize the stream on Slack's side.
      // Attach tool I/O metadata (invisible to users) for follow-up context,
      // and inject table blocks from draw_table if present.
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
      if (pendingTableBlock) stopBlocks.push(pendingTableBlock);
      stopBlocks.push(feedbackBlock);
      const stopArgs: Record<string, any> = { blocks: stopBlocks };
      if (toolMeta) stopArgs.metadata = toolMeta;

      try {
        await streamer.stop(stopArgs);
      } catch (stopErr: any) {
        if (isInvalidBlocks(stopErr)) {
          logger.warn("streamer.stop() rejected blocks, retrying without them", {
            channelId,
            slackError: stopErr?.data?.error,
            blockTypes: stopBlocks.map((b: any) => b.type),
          });
          logError({
            errorName: "StreamStopInvalidBlocks",
            errorMessage: stopErr?.message || "invalid_blocks on streamer.stop()",
            errorCode: stopErr?.data?.error || "invalid_blocks",
            channelId,
            context: { blockTypes: stopBlocks.map((b: any) => b.type) },
          });
          try {
            await streamer.stop();
          } catch {
            // Stream may already be finalized
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
        } else if (isChannelTypeNotSupported(stopErr)) {
          streamingUnsupportedChannels.add(channelId);
          logger.warn("streamer.stop() hit channel_type_not_supported, finalizing without payload", {
            channelId,
          });
          logError({
            errorName: "StreamStopChannelTypeNotSupported",
            errorMessage: stopErr?.message || "channel_type_not_supported on streamer.stop()",
            errorCode: "channel_type_not_supported",
            channelId,
          });
          try { await streamer.stop(); } catch { /* already finalized */ }
        } else {
          throw stopErr;
        }
      }

      logger.info(`LLM stream completed in ${llmMs}ms`, {
        rawLength: finalText.length,
        usage: { inputTokens, outputTokens, totalTokens },
      });
    }

    return {
      raw: finalText,
      alreadyPosted: true,
      usage: { inputTokens, outputTokens, totalTokens },
      toolCalls: toolCallRecords,
      modelId,
      stepsPromise: result.steps,
    };
  } catch (error: any) {
    clearTimeout(inactivityTimer);
    if (toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }
    if (streamKeepAlive) { clearInterval(streamKeepAlive); streamKeepAlive = null; }

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
          options.conversationContext,
          options.dynamicContext,
        );
        const retryResult = streamText({
          model: retryModel,
          system: retrySystemMessages,
          prompt: retryPrompt,
          abortSignal: retryAbortController.signal,
        });
        let retryText = "";

        for await (const chunk of retryResult.fullStream) {
          clearTimeout(retryInactivityTimer);
          retryInactivityTimer = setTimeout(() => {
            logger.warn("LLM retry inactivity timeout (180s), aborting");
            retryAbortController.abort();
          }, 180_000);

          if (chunk.type === "text-delta") {
            retryText += chunk.text;
            await tryStreamAppend({ markdown_text: chunk.text });
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

        return {
          raw: retryText,
          alreadyPosted: true,
          usage: {
            inputTokens: retryInputTokens,
            outputTokens: retryOutputTokens,
            totalTokens: retryInputTokens + retryOutputTokens,
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
          chunks: [{ type: "markdown_text", text: errorText }],
        });
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
  }
}
