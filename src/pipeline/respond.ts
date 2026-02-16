import { streamText, stepCountIs } from "ai";
import type { WebClient } from "@slack/web-api";
import { getMainModel } from "../lib/ai.js";
import { postProcessResponse } from "../personality/anti-patterns.js";
import { formatForSlack } from "../slack/formatter.js";
import { createSlackTools } from "../tools/slack.js";
import type { SlackImage } from "../lib/files.js";
import { logger } from "../lib/logger.js";

// ── Tool Status Messages ─────────────────────────────────────────────────────

const TOOL_STATUS: Record<string, string> = {
  web_search: "_Searching the web..._",
  read_url: "_Reading a link..._",
  read_channel_history: "_Reading channel history..._",
  read_canvas: "_Reading a canvas..._",
  list_channels: "_Looking at channels..._",
  join_channel: "_Joining a channel..._",
  search_messages: "_Searching messages..._",
  search_users: "_Looking up users..._",
  list_users: "_Looking up users..._",
  get_user_info: "_Looking up a profile..._",
  send_channel_message: "_Sending a message..._",
  send_direct_message: "_Sending a DM..._",
  send_thread_reply: "_Replying in thread..._",
  create_channel: "_Creating a channel..._",
  invite_to_channel: "_Inviting someone..._",
  schedule_action: "_Scheduling a task..._",
  list_scheduled_actions: "_Checking the schedule..._",
  save_note: "_Saving a note..._",
  read_note: "_Reading a note..._",
  edit_note: "_Editing a note..._",
  list_slack_list_items: "_Reading a list..._",
  create_canvas: "_Creating a canvas..._",
  edit_canvas: "_Editing a canvas..._",
  add_reaction: "_Reacting..._",
  set_my_status: "_Updating status..._",
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
}

export interface LLMResponse {
  /** The raw LLM output */
  raw: string;
  /** Post-processed and formatted for Slack */
  formatted: string;
  /** Any anti-pattern modifications made */
  modifications: string[];
  /** Flagged words found */
  flaggedWords: string[];
  /** Whether the response was already posted to Slack via streaming */
  alreadyPosted: boolean;
  /** Token usage */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

// ── Debounce Helper ──────────────────────────────────────────────────────────

const UPDATE_INTERVAL_MS = 1500;

// ── Main Function ────────────────────────────────────────────────────────────

/**
 * Stream LLM response with live Slack updates.
 *
 * Posts a placeholder message immediately, then progressively updates it
 * as text chunks arrive and tool calls are made. The final update contains
 * the post-processed, formatted response.
 */
export async function generateResponse(
  options: RespondOptions,
): Promise<LLMResponse> {
  const start = Date.now();
  const { slackClient, channelId, threadTs } = options;

  const model = await getMainModel();
  const hasImages = options.images && options.images.length > 0;

  // ── Post placeholder message ─────────────────────────────────────────
  let messageTs: string | undefined;
  try {
    const placeholderResult = await slackClient.chat.postMessage({
      channel: channelId,
      text: "...",
      thread_ts: threadTs,
    });
    messageTs = placeholderResult.ts;
  } catch (error: any) {
    logger.error("Failed to post placeholder message", {
      error: error.message,
    });
  }

  // Helper to update the placeholder message
  const updateMessage = async (text: string) => {
    if (!messageTs) return;
    try {
      await slackClient.chat.update({
        channel: channelId,
        ts: messageTs,
        text,
      });
    } catch {
      // Swallow update errors (rate limits, etc.)
    }
  };

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
  resetTimer(); // start the initial timer

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

  // ── Stream and update ────────────────────────────────────────────────
  let accumulatedText = "";
  let lastUpdateMs = 0;
  let currentToolStatus = "";

  try {
    const result = streamText(streamOptions);

    for await (const chunk of result.fullStream) {
      resetTimer(); // reset inactivity timer on every chunk

      switch (chunk.type) {
        case "tool-call": {
          // Show tool status in the placeholder
          const status =
            TOOL_STATUS[chunk.toolName] || `_Working on it..._`;
          currentToolStatus = status;

          // If we have accumulated text, show text + status
          const statusText = accumulatedText
            ? `${accumulatedText}\n\n${status}`
            : status;

          await updateMessage(statusText);
          lastUpdateMs = Date.now();
          break;
        }

        case "tool-result": {
          // Clear the tool status after tool completes
          currentToolStatus = "";
          break;
        }

        case "text-delta": {
          accumulatedText += chunk.text;

          // Debounced update: only update Slack every 1.5s
          const now = Date.now();
          if (now - lastUpdateMs >= UPDATE_INTERVAL_MS) {
            await updateMessage(accumulatedText);
            lastUpdateMs = now;
          }
          break;
        }
      }
    }

    // ── Final update ─────────────────────────────────────────────────────
    clearTimeout(inactivityTimer);

    const llmMs = Date.now() - start;

    // Get usage from the resolved promises
    const usage = await result.usage;

    // Always use accumulatedText as the source of truth.
    // result.text only contains the LAST step's text in multi-step responses
    // (e.g. text → tool call → text), which drops everything before the final step.
    // accumulatedText captures every text-delta across all steps.
    const finalText = accumulatedText;

    // Post-process: strip anti-patterns
    const { cleaned, flaggedWords, modifications } =
      postProcessResponse(finalText);

    // Format for Slack
    const formatted = formatForSlack(cleaned);

    // Final update with the post-processed version
    if (formatted.trim().length > 0) {
      await updateMessage(formatted);
    } else if (messageTs) {
      // If the response is empty (tool-only), delete the placeholder
      try {
        await slackClient.chat.delete({ channel: channelId, ts: messageTs });
      } catch {
        // If we can't delete, just update to empty-ish
        await updateMessage("_Done._");
      }
    }

    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;

    logger.info(`LLM stream completed in ${llmMs}ms`, {
      rawLength: finalText.length,
      cleanedLength: cleaned.length,
      modifications,
      flaggedWords,
      usage: { inputTokens, outputTokens, totalTokens },
    });

    return {
      raw: finalText,
      formatted,
      modifications,
      flaggedWords,
      alreadyPosted: true,
      usage: { inputTokens, outputTokens, totalTokens },
    };
  } catch (error: any) {
    clearTimeout(inactivityTimer);

    // If we have a placeholder, update it with an error/interruption message
    if (messageTs) {
      if (accumulatedText) {
        // Got partial text before the error — show what we have
        await updateMessage(
          accumulatedText + "\n\n_...interrupted. Something went wrong._",
        );
      } else {
        // Aborted during tool calls before any text was generated
        await updateMessage(
          "_Sorry, I got interrupted before I could finish. Try again?_",
        );
      }
    }

    throw error; // re-throw so the pipeline catch block handles it
  }
}
