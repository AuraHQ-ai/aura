import { streamText, generateText, stepCountIs } from "ai";
import type { WebClient } from "@slack/web-api";
import { getMainModel } from "../lib/ai.js";
import { createSlackTools } from "../tools/slack.js";
import type { SlackImage } from "../lib/files.js";
import { logger } from "../lib/logger.js";
import { TABLE_BLOCK_KEY } from "../tools/table.js";

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
  images?: SlackImage[];
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

// ── Main Function ────────────────────────────────────────────────────────────

/**
 * Stream LLM response to Slack using native chatStream API.
 *
 * Uses Slack's chat.startStream / chat.appendStream / chat.stopStream
 * (via the WebClient.chatStream() helper) for native streaming UX with
 * built-in buffering and rate limit handling.
 *
 * Tool calls are displayed as native Slack task cards in timeline mode.
 */
export async function generateResponse(
  options: RespondOptions,
): Promise<LLMResponse> {
  const start = Date.now();
  const { slackClient, channelId, threadTs } = options;

  const model = await getMainModel();
  const hasImages = options.images && options.images.length > 0;

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
    stopWhen: stepCountIs(25),
    abortSignal: abortController.signal,
  };

  if (hasImages) {
    const content: any[] = [
      { type: "text", text: options.userMessage },
      ...options.images!.map((img) => ({
        type: "image",
        image: img.data,
        mediaType: img.mimeType,
      })),
    ];
    streamOptions.messages = [{ role: "user", content }];
  } else {
    streamOptions.prompt = options.userMessage;
  }

  logger.info("Starting LLM stream", {
    model: model.modelId || "unknown",
    hasImages,
    toolCount: Object.keys(streamOptions.tools || {}).length,
    promptLength: options.systemPrompt.length,
  });

  // ── Stream and send to Slack ────────────────────────────────────────
  let accumulatedText = "";
  let pendingTableBlock: Record<string, any> | null = null;

  try {
    const result = streamText(streamOptions);

    for await (const chunk of result.fullStream) {
      resetTimer();

      switch (chunk.type) {
        case "text-delta": {
          accumulatedText += chunk.text;
          // SDK buffers internally (default 256 chars) — no manual debouncing
          await streamer.append({ markdown_text: chunk.text });
          break;
        }

        case "tool-call": {
          const title = TOOL_STATUS[chunk.toolName] || "Working on it...";
          const details = getToolDetails(chunk.toolName, (chunk as any).input ?? {});
          await streamer.append({
            chunks: [{
              type: "task_update",
              id: chunk.toolCallId,
              title,
              status: "in_progress",
              ...(details && { details }),
            }],
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

          await streamer.append({
            chunks: [{
              type: "task_update",
              id: chunk.toolCallId,
              title,
              status: isError ? "error" : "complete",
              ...(taskOutput && { output: taskOutput }),
              ...(sources && { sources }),
            }],
          });

          if (toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }
          resetTimer();
          break;
        }

        case "tool-error": {
          const title = TOOL_STATUS[(chunk as any).toolName] || "Failed";
          const err = (chunk as any).error;
          const errorMsg = err instanceof Error ? err.message : String(err);
          await streamer.append({
            chunks: [{
              type: "task_update",
              id: (chunk as any).toolCallId,
              title,
              status: "error",
              output: truncate(errorMsg, 200),
            }],
          });
          if (toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }
          resetTimer();
          break;
        }
      }
    }

    // ── Finalize stream ───────────────────────────────────────────────────
    clearTimeout(inactivityTimer);
    if (toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }

    const llmMs = Date.now() - start;
    const usage = await result.usage;

    const finalText = accumulatedText;

    // Stop the stream — finalizes the message on Slack's side.
    // If draw_table was called, inject the table block via `blocks`.
    await streamer.stop(
      pendingTableBlock ? { blocks: [pendingTableBlock as any] } : undefined,
    );

    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;

    logger.info(`LLM stream completed in ${llmMs}ms`, {
      rawLength: finalText.length,
      usage: { inputTokens, outputTokens, totalTokens },
    });

    return {
      raw: finalText,
      alreadyPosted: true,
      usage: { inputTokens, outputTokens, totalTokens },
    };
  } catch (error: any) {
    clearTimeout(inactivityTimer);
    if (toolKeepAlive) { clearInterval(toolKeepAlive); toolKeepAlive = null; }

    // ── Fallback: non-streaming for unsupported channel types ────────────
    if (error?.message?.includes("channel_type_not_supported")) {
      logger.warn("chatStream not supported in this channel type — falling back to generateText + postMessage", {
        channelId,
        errorMessage: error.message,
      });

      // Clean up the dead streamer
      try { await streamer.stop(); } catch { /* already dead */ }

      const generateOptions: any = {
        model,
        system: options.systemPrompt,
        tools: createSlackTools(options.slackClient, options.context),
        stopWhen: stepCountIs(25),
        abortSignal: AbortSignal.timeout(180_000),
      };

      if (hasImages) {
        generateOptions.messages = streamOptions.messages;
      } else {
        generateOptions.prompt = options.userMessage;
      }

      const genResult = await generateText(generateOptions);
      const text = genResult.text ?? "";

      await slackClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text,
      });

      const inputTokens = genResult.usage?.inputTokens ?? 0;
      const outputTokens = genResult.usage?.outputTokens ?? 0;
      const totalTokens = inputTokens + outputTokens;

      logger.info("generateText fallback completed", {
        rawLength: text.length,
        usage: { inputTokens, outputTokens, totalTokens },
      });

      return {
        raw: text,
        alreadyPosted: true,
        usage: { inputTokens, outputTokens, totalTokens },
      };
    }

    // Finalize the stream with an error message
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

    throw error;
  }
}
