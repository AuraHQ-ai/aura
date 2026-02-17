import { streamText, stepCountIs } from "ai";
import type { WebClient } from "@slack/web-api";
import { getMainModel } from "../lib/ai.js";
import { createSlackTools } from "../tools/slack.js";
import type { SlackImage } from "../lib/files.js";
import { logger } from "../lib/logger.js";

// ── Tool Status Messages ─────────────────────────────────────────────────────
// Plain text titles for native Slack task cards (no markdown formatting).

const TOOL_STATUS: Record<string, string> = {
  web_search: "Searching the web...",
  read_url: "Reading a link...",
  read_channel_history: "Reading channel history...",
  read_canvas: "Reading a canvas...",
  list_channels: "Looking at channels...",
  join_channel: "Joining a channel...",
  search_messages: "Searching messages...",
  search_users: "Looking up users...",
  list_users: "Looking up users...",
  get_user_info: "Looking up a profile...",
  send_channel_message: "Sending a message...",
  send_direct_message: "Sending a DM...",
  send_thread_reply: "Replying in thread...",
  create_channel: "Creating a channel...",
  invite_to_channel: "Inviting someone...",
  create_job: "Scheduling a job...",
  list_jobs: "Checking jobs...",
  cancel_job: "Cancelling a job...",
  save_note: "Saving a note...",
  read_note: "Reading a note...",
  edit_note: "Editing a note...",
  list_slack_list_items: "Reading a list...",
  create_canvas: "Creating a canvas...",
  edit_canvas: "Editing a canvas...",
  add_reaction: "Reacting...",
  set_my_status: "Updating status...",
  run_command: "Running a command in the sandbox...",
  patch_own_code: "Dispatching a coding agent (this may take a few minutes)...",
  read_own_source: "Reading my own source code...",
};

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

  // Keepalive interval during long tool calls (patch_own_code can take 3-10 min)
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
          await streamer.append({
            chunks: [{
              type: "task_update",
              id: chunk.toolCallId,
              title,
              status: "in_progress",
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

          await streamer.append({
            chunks: [{
              type: "task_update",
              id: chunk.toolCallId,
              title,
              status: isError ? "error" : "complete",
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

    // Stop the stream — finalizes the message on Slack's side
    await streamer.stop();

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
