import type { WebClient } from "@slack/web-api";
import { generateText } from "ai";
import { getFastModel } from "../lib/ai.js";
import type { ConversationContext, SlackThreadMessage } from "./slack-context.js";
import { logger } from "../lib/logger.js";

// ── Slack Event Types ────────────────────────────────────────────────────────
// Minimal local types — replaces the @slack/bolt dependency that was only used
// for these type imports.

export interface SlackMessageEvent {
  type: "message";
  channel: string;
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  channel_type?: string;
  subtype?: string;
  files?: Array<Record<string, unknown>>;
}

export interface SlackAppMentionEvent {
  type: "app_mention";
  channel: string;
  ts: string;
  text: string;
  user: string;
  thread_ts?: string;
  channel_type?: string;
}

export type SlackEvent = SlackMessageEvent | SlackAppMentionEvent;

export type ChannelType = "dm" | "public_channel" | "private_channel";

export interface MessageContext {
  /** The text of the user's message (with @mention stripped) */
  text: string;
  /** Slack user ID of the sender */
  userId: string;
  /** Slack channel ID */
  channelId: string;
  /** Channel type */
  channelType: ChannelType;
  /** Thread timestamp (if in a thread) */
  threadTs?: string;
  /** Message timestamp */
  messageTs: string;
  /** Whether this is a DM */
  isDm: boolean;
  /** Whether Aura was explicitly mentioned (@Aura) */
  isMentioned: boolean;
  /** Whether Aura was addressed by name */
  isAddressedByName: boolean;
}

/**
 * Parse a Slack message event into a structured context object.
 */
export function buildMessageContext(
  event: SlackEvent,
  botUserId: string,
): MessageContext | null {
  // Skip bot messages, message_changed, etc. -- but allow file_share (image uploads)
  if ("subtype" in event && event.subtype) {
    const allowedSubtypes = new Set(["file_share"]);
    if (!allowedSubtypes.has(event.subtype as string)) {
      logger.debug("Skipping message with subtype", { subtype: event.subtype });
      return null;
    }
  }

  // Skip messages from our own bot
  if ("bot_id" in event || ("user" in event && event.user === botUserId)) {
    return null;
  }

  const text = "text" in event ? (event.text || "") : "";
  const userId = "user" in event ? event.user! : "";
  const channelId = event.channel;

  // Allow empty text if the message has file attachments (image-only messages)
  const hasFiles = Array.isArray((event as any).files) && (event as any).files.length > 0;
  if (!userId || (!text.trim() && !hasFiles)) {
    return null;
  }

  // Determine channel type
  const channelType = resolveChannelType(event);

  // Check if Aura was mentioned
  const mentionPattern = new RegExp(`<@${botUserId}>`, "g");
  const isMentioned = mentionPattern.test(text);

  // Check if addressed by name (case-insensitive "Aura" at start or "Aura," anywhere)
  const isAddressedByName = /\baura[,:]?\s/i.test(text) || /\baura[?!.]?\s*$/i.test(text);

  // Strip the @mention from the text
  const cleanText = text.replace(mentionPattern, "").trim();

  // Determine thread context
  const threadTs = "thread_ts" in event ? event.thread_ts : undefined;
  const messageTs = "ts" in event ? event.ts : "";

  return {
    text: cleanText,
    userId,
    channelId,
    channelType,
    threadTs,
    messageTs,
    isDm: channelType === "dm",
    isMentioned,
    isAddressedByName,
  };
}

export interface ShouldRespondResult {
  respond: boolean;
  reason: string;
}

/**
 * Determine if Aura should respond to this message (Tiers 2–3 only).
 *
 * Tier 1 (DMs, explicit @mention, addressed by name) is handled inline
 * by the pipeline before this function is called — see `runPipeline` in
 * `index.ts`. This function is only invoked when Tier 1 did NOT match.
 *
 * Tiers handled here:
 * 2. LLM gate: Aura is a thread participant or it's her thread
 * 3. LLM gate: Aura posted recently in the channel (non-threaded, within 1h)
 * 4. Default: don't respond
 */
export async function shouldRespond(
  context: MessageContext,
  conversation: ConversationContext,
): Promise<ShouldRespondResult> {
  // Tier 2: Aura is a thread participant or it's her thread
  if (conversation.isAuraParticipant || conversation.isAuraThread) {
    const shouldReply = await llmShouldRespond(context, conversation, true);
    return {
      respond: shouldReply,
      reason: shouldReply ? "thread_participant_llm_yes" : "thread_participant_llm_no",
    };
  }

  // Tier 3: Aura posted recently in the channel (non-threaded)
  if (conversation.auraRecentlyActive) {
    const shouldReply = await llmShouldRespond(context, conversation, false);
    return {
      respond: shouldReply,
      reason: shouldReply ? "recent_channel_llm_yes" : "recent_channel_llm_no",
    };
  }

  // Default: don't respond
  return { respond: false, reason: "no_trigger" };
}

// ── LLM Gate ─────────────────────────────────────────────────────────────────

const SHOULD_RESPOND_PROMPT_PARTICIPANT = `You are deciding whether Aura (a Slack bot and team assistant) should respond to the latest message.

Aura is already a participant in this conversation (she has sent messages before).

Rules:
- Answer RESPOND if the message asks a question, requests an action, continues a conversation that needs Aura's input, shares information Aura should acknowledge, or is clearly directed at Aura.
- Answer SKIP if the message is just an acknowledgment (thanks, ok, got it, thumbs up), is directed at someone else, or is something where responding would add nothing.
- When in doubt, lean toward RESPOND — it's better to be helpful than to ignore someone.

Answer with a single word: RESPOND or SKIP.`;

const SHOULD_RESPOND_PROMPT_RECENTLY_ACTIVE = `You are deciding whether Aura (a Slack bot and team assistant) should respond to the latest message.

Aura has been active in this channel recently, but is NOT necessarily a participant in this specific conversation or thread.

Rules:
- Answer RESPOND if the message asks a question, requests an action, shares information Aura should acknowledge, or is clearly directed at Aura.
- Answer SKIP if the message is just an acknowledgment (thanks, ok, got it, thumbs up), is directed at someone else, is part of an ongoing conversation between other people that Aura is not involved in, or is something where responding would add nothing.
- When in doubt, lean toward SKIP — Aura should not intrude on conversations she's not part of.

Answer with a single word: RESPOND or SKIP.`;

/**
 * Ask the fast model (Haiku) whether Aura should respond to a message
 * in a conversation she's participating in.
 *
 * @param isParticipant - true if Aura is a direct participant in this thread/conversation (Tier 2),
 *   false if she's only recently active in the channel (Tier 3).
 *
 * Returns true if the model says RESPOND, false if SKIP.
 * Defaults to true on any failure (better to over-respond than miss).
 */
async function llmShouldRespond(
  context: MessageContext,
  conversation: ConversationContext,
  isParticipant: boolean,
): Promise<boolean> {
  try {
    // Build a concise view of the last few messages
    const messages =
      conversation.thread && conversation.thread.length > 0
        ? conversation.thread
        : conversation.recentMessages;
    const recent = messages.slice(-5);
    const conversationText = recent
      .map((m: SlackThreadMessage) => `[${m.displayName}]: ${m.text}`)
      .join("\n");

    // Resolve the sender's display name from conversation messages, falling back to raw ID
    const senderEntry = messages.find((m) => m.user === context.userId);
    const senderName = senderEntry?.displayName ?? context.userId;

    const systemPrompt = isParticipant
      ? SHOULD_RESPOND_PROMPT_PARTICIPANT
      : SHOULD_RESPOND_PROMPT_RECENTLY_ACTIVE;

    const userMessage = `Recent conversation:\n${conversationText}\n\nLatest message from ${senderName}:\n${context.text}\n\nShould Aura respond?`;

    const model = await getFastModel();
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: userMessage,
      maxOutputTokens: 5,
    });

    const answer = result.text.trim().toUpperCase();
    const shouldReply = answer.startsWith("RESPOND");

    logger.debug("LLM shouldRespond gate", {
      answer: result.text.trim(),
      shouldReply,
      userId: context.userId,
      channelId: context.channelId,
    });

    return shouldReply;
  } catch (error: any) {
    // Tier 2 (participant): fail open — better to over-respond than miss.
    // Tier 3 (recently active): fail closed — don't intrude on unrelated conversations.
    const fallback = isParticipant;
    logger.error("LLM shouldRespond gate failed", {
      error: error.message,
      fallback: fallback ? "RESPOND" : "SKIP",
      isParticipant,
    });
    return fallback;
  }
}

function resolveChannelType(
  event: SlackEvent,
): ChannelType {
  if ("channel_type" in event) {
    const ct = (event as any).channel_type;
    if (ct === "im") return "dm";
    if (ct === "group" || ct === "mpim") return "private_channel";
    return "public_channel";
  }
  return "public_channel";
}

// ── Slack Entity Resolution ──────────────────────────────────────────────────

/** Per-invocation cache for user ID -> name lookups */
const userNameCache = new Map<string, string>();

/** Per-invocation cache for channel ID -> name lookups */
const channelNameCache = new Map<string, string>();

/**
 * Resolve Slack entity references in message text to human-readable format.
 *
 * Transforms:
 * - <@U066V1AN6>        -> @jonas (U066V1AN6)
 * - <#C0BNVKS77|dev>    -> #dev (C0BNVKS77)
 * - <#C0BNVKS77>        -> #dev (C0BNVKS77)
 *
 * The LLM then sees both the name and the ID, so tools can use either.
 */
export async function resolveSlackEntities(
  client: WebClient,
  text: string,
): Promise<string> {
  // Match all Slack entity references: <@U...>, <#C...|name>, <#C...>
  const entityPattern = /<(@|#)([A-Z0-9]+)(?:\|([^>]*))?>/g;
  const matches = [...text.matchAll(entityPattern)];

  if (matches.length === 0) return text;

  let resolved = text;

  for (const match of matches) {
    const [fullMatch, type, id, label] = match;

    if (type === "@") {
      // User mention: <@U066V1AN6>
      const name = await resolveUserId(client, id);
      resolved = resolved.replace(fullMatch, `@${name} (${id})`);
    } else if (type === "#") {
      // Channel mention: <#C0BNVKS77|dev> or <#C0BNVKS77>
      if (label) {
        // Label already provided by Slack
        resolved = resolved.replace(fullMatch, `#${label} (${id})`);
      } else {
        const name = await resolveChannelId(client, id);
        resolved = resolved.replace(fullMatch, `#${name} (${id})`);
      }
    }
  }

  return resolved;
}

async function resolveUserId(
  client: WebClient,
  userId: string,
): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  try {
    const result = await client.users.info({ user: userId });
    const name =
      result.user?.profile?.display_name ||
      result.user?.real_name ||
      result.user?.name ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

async function resolveChannelId(
  client: WebClient,
  channelId: string,
): Promise<string> {
  const cached = channelNameCache.get(channelId);
  if (cached) return cached;

  try {
    const result = await client.conversations.info({ channel: channelId });
    const name = (result.channel as any)?.name || channelId;
    channelNameCache.set(channelId, name);
    return name;
  } catch {
    return channelId;
  }
}
