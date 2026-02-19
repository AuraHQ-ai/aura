import { streamText, stepCountIs } from "ai";
import type { WebClient } from "@slack/web-api";
import { getMainModel } from "../lib/ai.js";
import { createSlackTools } from "../tools/slack.js";
import type { FileContentPart } from "../lib/files.js";
import { logger } from "../lib/logger.js";
import { TABLE_BLOCK_KEY } from "../tools/table.js";

// ── Tool I/O Persistence ─────────────────────────────────────────────────────
// Accumulated during streaming and attached as invisible Slack message metadata
// so that follow-up turns can see actual tool inputs and outputs.

export const TOOL_IO_EVENT_TYPE = "aura_tool_io";

/** Max bytes for serialized tool I/O metadata (Slack limit is 16 KB). */
const METADATA_BUDGET = 8_000;

interface ToolCallRecord {
  /** Tool name */
  name: string;
  /** JSON-serialized input args */
  input: string;
  /** JSON-serialized (and truncated) output */
  output: string;
  /** Whether the tool errored */
  is_error: boolean;
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

// ── Tool Status Messages ─────────────────────────────────────────────────────
// Plain text titles for native Slack task cards (no markdown formatting).

const TOOL_STATUS: Record<string, string> = {
  // Web
  web_search: "Searching the web...",
  read_url: "Reading a link...",
  // Slack channels
  list_channels: "Looking at channels...",
  join_channel: "Joining a channel...",
  leave_channel: "Leaving a channel...",
  create_channel: "Creating a channel...",
  set_channel_topic: "Setting channel topic...",
  read_channel_history: "Reading channel history...",
  send_channel_message: "Sending a message...",
  send_thread_reply: "Replying in thread...",
  invite_to_channel: "Inviting someone...",
  // Slack users
  list_users: "Looking up users...",
  search_users: "Looking up users...",
  get_user_info: "Looking up a profile...",
  // Slack DMs
  send_direct_message: "Sending a DM...",
  read_dm_history: "Reading DM history...",
  list_dm_conversations: "Listing DM conversations...",
  // Slack messages
  search_messages: "Searching messages...",
  edit_message: "Editing a message...",
  delete_message: "Deleting a message...",
  add_reaction: "Reacting...",
  remove_reaction: "Removing a reaction...",
  // Slack lists
  list_slack_list_items: "Reading a list...",
  get_slack_list_item: "Reading a list item...",
  create_slack_list_item: "Adding a list item...",
  update_slack_list_item: "Updating a list item...",
  delete_slack_list_item: "Removing a list item...",
  // Slack canvases
  read_canvas: "Reading a canvas...",
  create_canvas: "Creating a canvas...",
  edit_canvas: "Editing a canvas...",
  // Notes
  save_note: "Saving a note...",
  read_note: "Reading a note...",
  edit_note: "Editing a note...",
  list_notes: "Listing notes...",
  delete_note: "Deleting a note...",
  checkpoint_plan: "Saving progress...",
  // Jobs
  create_job: "Scheduling a job...",
  list_jobs: "Checking jobs...",
  cancel_job: "Cancelling a job...",
  // BigQuery
  list_datasets: "Listing datasets...",
  list_tables: "Listing tables...",
  inspect_table: "Inspecting table schema...",
  execute_query: "Running a SQL query...",
  // Sandbox & code
  run_command: "Running a command in the sandbox...",
  patch_own_code: "Dispatching a coding agent (this may take a few minutes)...",
  // Misc
  set_my_status: "Updating status...",
  draw_table: "Drawing a table...",
};

// ── Task Card Helpers ────────────────────────────────────────────────────────

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Extract a short detail string from tool args for the in-progress card. */
function getToolDetails(toolName: string, args: Record<string, any>): string | undefined {
  switch (toolName) {
    case "execute_query": return truncate(args.sql, 120);
    case "run_command": return truncate(args.command, 120);
    case "web_search": return args.query;
    case "search_messages": return args.query;
    case "read_url": return args.url;
    case "inspect_table": return args.dataset && args.table ? `${args.dataset}.${args.table}` : args.dataset ?? args.table;
    case "list_tables": return args.dataset;
    case "read_channel_history": return args.channel;
    case "read_note": case "save_note": case "edit_note": return args.topic;
    default: return undefined;
  }
}

/** Extract a short output summary from tool results for the completed card. */
function getToolOutput(toolName: string, output: any): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  if (output.ok === false) return output.error;

  switch (toolName) {
    case "execute_query": return `${output.total_rows ?? 0} rows`;
    case "web_search": return `${output.count ?? 0} results`;
    case "search_messages": return `${output.count ?? 0} messages`;
    case "run_command":
      return output.exit_code === 0 ? undefined : `Exit code ${output.exit_code}`;
    case "read_channel_history": return `${output.count ?? 0} messages`;
    case "inspect_table":
      return `${output.row_count ?? "?"} rows, ${(output.schema ?? []).length} columns`;
    case "list_tables": return `${(output.tables ?? []).length} tables`;
    case "list_datasets": return `${(output.datasets ?? []).length} datasets`;
    default: return undefined;
  }
}

/** Extract URL sources from web tool results for card citations. */
function getToolSources(
  toolName: string,
  output: any,
): Array<{ type: "url"; url: string; text: string }> | undefined {
  if (!output || typeof output !== "object" || output.ok === false) return undefined;
  if (toolName === "web_search" && Array.isArray(output.results)) {
    return output.results.slice(0, 3).map((r: any) => ({
      type: "url" as const,
      url: r.url,
      text: r.title || r.url,
    }));
  }
  if (toolName === "read_url" && output.url) {
    try {
      return [{ type: "url", url: output.url, text: new URL(output.url).hostname }];
    } catch {
      return [{ type: "url", url: output.url, text: output.url }];
    }
  }
  return undefined;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface RespondOptions {
  systemPrompt: string;
  userMessage: string;
  slackClient: WebClient;
  context?: { userId?: string; channelId?: string; threadTs?: string };
  files?: FileContentPart[];
  channelId: string;
  threadTs?: string;
  /** Slack team ID — required for chatStream in channels */
  teamId?: string;
  /** Slack user ID of the message author — required for chatStream in channels */
  recipientUserId?: string;
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
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Detect Slack's `channel_type_not_supported` error, which is thrown when
 * `chat.startStream` is called on a channel type that doesn't support
 * streaming (e.g. Slack List internal channels).
 */
function isStreamingUnsupported(error: any): boolean {
  const msg = error?.message || "";
  const code = error?.data?.error || "";
  return (
    msg.includes("channel_type_not_supported") ||
    code === "channel_type_not_supported"
  );
}

function isInvalidBlocks(error: any): boolean {
  const msg = error?.message || "";
  const code = error?.data?.error || "";
  return msg.includes("invalid_blocks") || code === "invalid_blocks";
}

function isUnsupportedFileError(error: any): boolean {
  const msg = error?.message || error?.toString() || "";
  const name = error?.name || "";
  return (
    name === "AI_UnsupportedFunctionalityError" ||
    msg.includes("UnsupportedFunctionality") ||
    msg.includes("unsupported file") ||
    msg.includes("unsupported mime")
  );
}

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

  const model = await getMainModel();
  const hasFiles = options.files && options.files.length > 0;

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

  const streamer = slackClient.chatStream(streamParams as any);

  // ── Streaming fallback ──────────────────────────────────────────────
  // Some channel types (e.g. Slack List internal channels) don't support
  // chat.startStream. When we detect this, we flip to buffer-only mode
  // and post the final result via chat.postMessage.
  let streamingFailed = false;

  async function tryStreamAppend(payload: any): Promise<void> {
    if (streamingFailed) return;
    try {
      await streamer.append(payload);
    } catch (err: any) {
      if (isStreamingUnsupported(err)) {
        streamingFailed = true;
        logger.warn(
          "chatStream not supported for this channel, falling back to postMessage",
          { channelId },
        );
      } else if (isInvalidBlocks(err)) {
        streamingFailed = true;
        logger.warn("chatStream append returned invalid_blocks, falling back to postMessage", {
          channelId,
          slackError: err?.data?.error,
          payloadKeys: Object.keys(payload),
        });
      } else {
        throw err;
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

  // ── Build stream options ─────────────────────────────────────────────
  const streamOptions: any = {
    model,
    system: options.systemPrompt,
    tools: createSlackTools(options.slackClient, options.context),
    stopWhen: stepCountIs(250),
    abortSignal: abortController.signal,
  };

  if (hasFiles) {
    const content: any[] = [
      { type: "text", text: options.userMessage },
      ...options.files!,
    ];
    streamOptions.messages = [{ role: "user", content }];
  } else {
    streamOptions.prompt = options.userMessage;
  }

  logger.info("Starting LLM stream", {
    model: model.modelId || "unknown",
    hasFiles,
    toolCount: Object.keys(streamOptions.tools || {}).length,
    promptLength: options.systemPrompt.length,
  });

  // ── Stream and send to Slack ────────────────────────────────────────
  let accumulatedText = "";
  let pendingTableBlock: Record<string, any> | null = null;
  const toolCallRecords: ToolCallRecord[] = [];
  const pendingToolInputs = new Map<string, { name: string; input: string }>();

  try {
    const result = streamText(streamOptions);

    for await (const chunk of result.fullStream) {
      resetTimer();

      switch (chunk.type) {
        case "text-delta": {
          accumulatedText += chunk.text;
          await tryStreamAppend({ markdown_text: chunk.text });
          break;
        }

        case "tool-call": {
          const title = TOOL_STATUS[chunk.toolName] || "Working on it...";
          const inputArgs = (chunk as any).input ?? {};
          const details = getToolDetails(chunk.toolName, inputArgs);
          await tryStreamAppend({
            chunks: [{
              type: "task_update",
              id: chunk.toolCallId,
              title,
              status: "in_progress",
              ...(details && { details }),
            }],
          });

          pendingToolInputs.set(chunk.toolCallId, {
            name: chunk.toolName,
            input: truncateToBytes(JSON.stringify(inputArgs), 1500),
          });

          // Keep resetting inactivity timer during long tool execution
          if (toolKeepAlive) clearInterval(toolKeepAlive);
          toolKeepAlive = setInterval(() => resetTimer(), 60_000);
          break;
        }

        case "tool-result": {
          const title = TOOL_STATUS[chunk.toolName] || "Done";
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

          const taskOutput = getToolOutput(chunk.toolName, output);
          const sources = getToolSources(chunk.toolName, output);

          await tryStreamAppend({
            chunks: [{
              type: "task_update",
              id: chunk.toolCallId,
              title,
              status: isError ? "error" : "complete",
              ...(taskOutput && { output: taskOutput }),
              ...(sources && { sources }),
            }],
          });

          const pending = pendingToolInputs.get(chunk.toolCallId);
          toolCallRecords.push({
            name: chunk.toolName,
            input: pending?.input ?? "{}",
            output: serializeToolOutput(chunk.toolName, output),
            is_error: !!isError,
          });
          pendingToolInputs.delete(chunk.toolCallId);

          if (pendingToolInputs.size === 0 && toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }
          resetTimer();
          break;
        }

        case "tool-error": {
          const errToolName = (chunk as any).toolName;
          const errToolCallId = (chunk as any).toolCallId;
          const title = TOOL_STATUS[errToolName] || "Failed";
          const err = (chunk as any).error;
          const errorMsg = err instanceof Error ? err.message : String(err);
          await tryStreamAppend({
            chunks: [{
              type: "task_update",
              id: errToolCallId,
              title,
              status: "error",
              output: truncate(errorMsg, 200),
            }],
          });

          const pending = pendingToolInputs.get(errToolCallId);
          toolCallRecords.push({
            name: errToolName || "unknown",
            input: pending?.input ?? "{}",
            output: truncateToBytes(JSON.stringify({ error: errorMsg }), 1500),
            is_error: true,
          });
          pendingToolInputs.delete(errToolCallId);

          if (pendingToolInputs.size === 0 && toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }
          resetTimer();
          break;
        }
      }
    }

    // ── Finalize ──────────────────────────────────────────────────────────
    clearTimeout(inactivityTimer);
    if (toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }

    const llmMs = Date.now() - start;
    const usage = await result.usage;

    const finalText = accumulatedText;

    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;

    if (streamingFailed) {
      // Fallback: post the complete response via chat.postMessage.
      // When blocks are present, Slack only renders blocks — text is just a
      // notification fallback. Include the LLM text as section blocks so it
      // remains visible alongside the table.
      const blocks: any[] = [];
      if (finalText) {
        for (let i = 0; i < finalText.length; i += 3000) {
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: finalText.slice(i, i + 3000) },
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
      const fallbackText = finalText || "_I processed your request but had nothing to say._";

      try {
        await slackClient.chat.postMessage({
          channel: channelId,
          text: fallbackText,
          thread_ts: threadTs,
          blocks,
          ...(toolMeta && { metadata: toolMeta }),
        });
      } catch (postErr: any) {
        if (isInvalidBlocks(postErr)) {
          logger.warn("Fallback postMessage rejected blocks, retrying as plain text", {
            channelId,
            slackError: postErr?.data?.error,
            blockTypes: blocks.map((b: any) => b.type),
          });
          await slackClient.chat.postMessage({
            channel: channelId,
            text: fallbackText,
            thread_ts: threadTs,
          });
        } else {
          throw postErr;
        }
      }

      logger.info(`LLM completed in ${llmMs}ms (fallback postMessage)`, {
        rawLength: finalText.length,
        channelId,
        usage: { inputTokens, outputTokens, totalTokens },
      });
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
          try {
            await streamer.stop();
          } catch {
            // Stream may already be finalized — nothing we can do
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

    return {
      raw: finalText,
      alreadyPosted: true,
      usage: { inputTokens, outputTokens, totalTokens },
    };
  } catch (error: any) {
    clearTimeout(inactivityTimer);
    if (toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }

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

      const retryOptions: any = {
        model,
        system: options.systemPrompt,
        prompt: retryPrompt,
        abortSignal: retryAbortController.signal,
      };

      try {
        const retryResult = streamText(retryOptions);
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
          try { await streamer.stop(); } catch { /* already closed */ }
        } else {
          const fallbackText = retryText || "_I processed your request but had nothing to say._";
          await slackClient.chat.postMessage({
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
        };
      } catch (retryError) {
        clearTimeout(retryInactivityTimer);
        logger.error("Retry without files also failed", {
          channelId,
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
        // Fall through to stream cleanup below
      }
    }

    // If streaming was never established, don't try to stop it
    if (!streamingFailed) {
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

    throw error;
  }
}
