import type { KnownEventFromType, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
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
