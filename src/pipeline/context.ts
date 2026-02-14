import type { KnownEventFromType, SlackEventMiddlewareArgs } from "@slack/bolt";
import { logger } from "../lib/logger.js";

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
  event: KnownEventFromType<"message"> | KnownEventFromType<"app_mention">,
  botUserId: string,
): MessageContext | null {
  // Skip bot messages, message_changed, etc.
  if ("subtype" in event && event.subtype) {
    logger.debug("Skipping message with subtype", { subtype: event.subtype });
    return null;
  }

  // Skip messages from our own bot
  if ("bot_id" in event || ("user" in event && event.user === botUserId)) {
    return null;
  }

  const text = "text" in event ? (event.text || "") : "";
  const userId = "user" in event ? event.user! : "";
  const channelId = event.channel;

  if (!userId || !text.trim()) {
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

/**
 * Determine if Aura should respond to this message.
 *
 * Rules:
 * - In DMs: always respond
 * - In channels: only if @mentioned or addressed by name
 */
export function shouldRespond(context: MessageContext): boolean {
  if (context.isDm) return true;
  if (context.isMentioned) return true;
  if (context.isAddressedByName) return true;
  return false;
}

function resolveChannelType(
  event: KnownEventFromType<"message"> | KnownEventFromType<"app_mention">,
): ChannelType {
  if ("channel_type" in event) {
    const ct = (event as any).channel_type;
    if (ct === "im") return "dm";
    if (ct === "group" || ct === "mpim") return "private_channel";
    return "public_channel";
  }
  return "public_channel";
}
