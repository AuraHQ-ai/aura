import { tool } from "ai";
import { z } from "zod";
import type { WebClient } from "@slack/web-api";
import { logger } from "../lib/logger.js";
import { isAdmin } from "../lib/permissions.js";
import { createNoteTools } from "./notes.js";
import { createJobTools } from "./jobs.js";
import { createListWriteTools } from "./lists.js";
import { createSandboxTools } from "./sandbox.js";
import { createWebTools } from "./web.js";
import { createBigQueryTools } from "./bigquery.js";
import { createTableTools } from "./table.js";
import { createCursorAgentTools } from "./cursor-agent.js";
import { createConversationSearchTools } from "./conversations.js";
import { createEmailTools, createGmailEATools } from "./email.js";
import { createSheetsTools } from "./sheets.js";
import type { ScheduleContext } from "../db/schema.js";
import { formatForSlack } from "../lib/format.js";
import { formatTimestamp } from "../lib/temporal.js";

// ── Caches (per function invocation) ─────────────────────────────────────────

/** Cached channel list — avoids repeated conversations.list calls within one invocation. */
let channelCache: { id: string; name: string }[] | null = null;

async function getChannelList(
  client: WebClient,
): Promise<{ id: string; name: string }[]> {
  if (channelCache) return channelCache;

  const channels: { id: string; name: string }[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });

    for (const ch of result.channels || []) {
      if (ch.id && ch.name) {
        channels.push({ id: ch.id, name: ch.name });
      }
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  channelCache = channels;
  return channels;
}

/** Cached user list — avoids repeated users.list calls. */
let userCache:
  | { id: string; displayName: string; realName: string; username: string }[]
  | null = null;

export async function getUserList(
  client: WebClient,
): Promise<
  { id: string; displayName: string; realName: string; username: string }[]
> {
  if (userCache) return userCache;

  const users: {
    id: string;
    displayName: string;
    realName: string;
    username: string;
  }[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.users.list({ limit: 200, cursor });

    for (const u of result.members || []) {
      if (u.deleted || u.is_bot || !u.id) continue;
      users.push({
        id: u.id,
        displayName: u.profile?.display_name || "",
        realName: u.real_name || "",
        username: u.name || "",
      });
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  userCache = users;
  return users;
}

/** Cache for user ID -> display name lookups. */
const userIdNameCache = new Map<string, string>();

/** Cache for channel ID -> full metadata lookups. */
const channelIdNameCache = new Map<string, { id: string; name: string; is_private: boolean; topic: string; purpose: string; num_members: number }>();

// ── User-token client (for search.messages which requires a user token) ─────

let _userClient: WebClient | null | undefined;

async function getUserClient(): Promise<WebClient | null> {
  if (_userClient !== undefined) return _userClient;
  const token = process.env.SLACK_USER_TOKEN;
  if (!token) {
    _userClient = null;
    return null;
  }
  const { WebClient } = await import("@slack/web-api");
  _userClient = new WebClient(token);
  return _userClient;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract text from all rich-content locations in a Slack message.
 * Slack messages can carry content in msg.text, attachments (forwarded/shared
 * messages), rich_text blocks, and file shares.
 */
function extractFullMessageText(msg: any): string {
  const parts: string[] = [];
  if (msg.text) parts.push(msg.text);
  if (Array.isArray(msg.attachments)) {
    for (const att of msg.attachments) {
      const attParts: string[] = [];
      if (att.pretext) attParts.push(att.pretext);
      if (att.title) attParts.push(att.title);
      if (att.text) attParts.push(att.text);
      else if (att.fallback) attParts.push(att.fallback);
      if (attParts.length > 0) {
        const label = att.is_msg_unfurl ? "[forwarded message]" : "[attachment]";
        parts.push(`${label} ${attParts.join(" — ")}`);
      }
    }
  }
  if (Array.isArray(msg.blocks)) {
    for (const block of msg.blocks) {
      if (block.type === "rich_text" && Array.isArray(block.elements)) {
        for (const section of block.elements) {
          if (Array.isArray(section.elements)) {
            const sectionText = section.elements
              .filter((el: any) => el.type === "text" && el.text)
              .map((el: any) => el.text)
              .join("");
            if (sectionText) parts.push(sectionText);
          }
        }
      }
    }
  }
  if (Array.isArray(msg.files)) {
    for (const file of msg.files) {
      const fileName = file.title || file.name || "unnamed file";
      const fileType = file.filetype || "unknown";
      parts.push(`[file: ${fileName} (${fileType})]`);
    }
  }
  return parts.filter(Boolean).join("\n") || "";
}

function generateAttachmentsSummary(msg: any): string | null {
  if (!Array.isArray(msg.attachments) || msg.attachments.length === 0) return null;
  const summaries = msg.attachments.map((att: any) => {
    const parts: string[] = [];
    if (att.author_name) parts.push(`from: ${att.author_name}`);
    if (att.title) parts.push(att.title);
    if (att.text) parts.push(att.text.substring(0, 200));
    return parts.join(" — ") || att.fallback || "attachment";
  });
  return summaries.join("; ");
}

/**
 * Search for a public channel by name.
 * The bot token with channels:read scope can see all public channels,
 * including ones the bot hasn't joined yet.
 */
async function searchPublicChannelByName(
  client: WebClient,
  name: string,
): Promise<{ id: string; name: string } | null> {
  try {
    const cleanLower = name.toLowerCase();

    let cursor: string | undefined;
    do {
      const result = await client.conversations.list({
        types: "public_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });

      for (const ch of result.channels || []) {
        if (ch.id && ch.name && ch.name.toLowerCase() === cleanLower) {
          return { id: ch.id, name: ch.name };
        }
      }

      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return null;
  } catch (error: any) {
    logger.warn("searchPublicChannelByName failed", {
      name,
      error: error.message,
    });
    return null;
  }
}

/**
 * Resolve a channel name or ID to a channel object.
 * Accepts: "general", "#general", "C0BNVKS77", "#dev (C0BNVKS77)"
 *
 * When fallbackToUserToken is true and the bot's channel cache misses,
 * falls back to searching all public channels via the user token.
 * This is needed for join_channel — the bot can't see channels it hasn't joined.
 */
export async function resolveChannelByName(
  client: WebClient,
  name: string,
  options?: { fallbackToUserToken?: boolean },
): Promise<{ id: string; name: string } | null> {
  const cleaned = name.replace(/^#/, "").trim();

  // Extract parenthetical ID if present: "dev (C0BNVKS77)" -> use ID
  const idInParens = cleaned.match(/\((C[A-Z0-9]+)\)/);
  if (idInParens) {
    const id = idInParens[1];
    const displayName = cleaned.replace(/\s*\(?C[A-Z0-9]+\)?/, "").trim();
    return { id, name: displayName || id };
  }

  // If it looks like a raw channel ID, resolve the actual name
  if (/^C[A-Z0-9]+$/.test(cleaned)) {
    const resolved = await resolveChannelById(client, cleaned);
    return resolved ? { id: resolved.id, name: resolved.name } : { id: cleaned, name: cleaned };
  }

  // Name-based lookup via bot's cache (channels bot is already in)
  const channels = await getChannelList(client);
  const match = channels.find(
    (ch) => ch.name.toLowerCase() === cleaned.toLowerCase(),
  );
  if (match) return match;

  // Fallback: search all public channels via user token
  if (options?.fallbackToUserToken) {
    const fallbackMatch = await searchPublicChannelByName(client, cleaned);
    if (fallbackMatch) {
      logger.info(
        "resolveChannelByName: found channel via user token fallback",
        {
          name: cleaned,
          channelId: fallbackMatch.id,
        },
      );
      return fallbackMatch;
    }
  }

  return null;
}

/**
 * Resolve a user display name, username, or ID to a user object.
 * Accepts: "jonas", "@jonas", "U066V1AN6", "jonas (U066V1AN6)"
 */
export async function resolveUserByName(
  client: WebClient,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const cleaned = name.replace(/^@/, "").trim();

  // Extract parenthetical ID if present: "jonas (U066V1AN6)" -> use ID
  const idInParens = cleaned.match(/\(?(U[A-Z0-9]+)\)?/);
  if (idInParens) {
    const id = idInParens[1];
    const displayName = cleaned.replace(/\s*\(?U[A-Z0-9]+\)?/, "").trim();
    return { id, name: displayName || id };
  }

  // If it looks like a raw user ID
  if (/^U[A-Z0-9]+$/.test(cleaned)) {
    return { id: cleaned, name: cleaned };
  }

  // Name-based lookup via cache
  const cleanLower = cleaned.toLowerCase();
  const users = await getUserList(client);

  const match = users.find(
    (u) =>
      u.displayName.toLowerCase() === cleanLower ||
      u.realName.toLowerCase() === cleanLower ||
      u.username.toLowerCase() === cleanLower,
  );

  if (match) {
    return {
      id: match.id,
      name: match.displayName || match.realName || match.username,
    };
  }

  return null;
}

/**
 * Resolve a Slack user ID to a display name.
 * Caches results for the duration of the invocation.
 */
async function resolveUserById(
  client: WebClient,
  userId: string,
): Promise<string> {
  const cached = userIdNameCache.get(userId);
  if (cached) return cached;

  try {
    const result = await client.users.info({ user: userId });
    const name =
      result.user?.profile?.display_name ||
      result.user?.real_name ||
      result.user?.name ||
      userId;
    userIdNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

/**
 * Resolve a Slack channel ID to its name and metadata.
 * Caches results for the duration of the invocation.
 * Uses bot token first, falls back to user token for channels the bot isn't in.
 */
export async function resolveChannelById(
  client: WebClient,
  channelId: string,
): Promise<{ id: string; name: string; is_private: boolean; topic: string; purpose: string; num_members: number } | null> {
  const cached = channelIdNameCache.get(channelId);
  if (cached) return { ...cached };

  try {
    const result = await client.conversations.info({ channel: channelId, include_num_members: true });
    const ch = result.channel as any;
    if (ch) {
      const entry = {
        id: channelId,
        name: ch.name || channelId,
        is_private: ch.is_private || false,
        topic: ch.topic?.value || "",
        purpose: ch.purpose?.value || "",
        num_members: ch.num_members || 0,
      };
      channelIdNameCache.set(channelId, entry);
      return { ...entry };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

/**
 * Create Slack tools for the AI SDK.
 * Each tool receives the WebClient via closure.
 */
export function createSlackTools(client: WebClient, context?: ScheduleContext) {
  // Resolve thread coordinates for Slack List items.
  // List channels use the list ID with a C prefix (F088... → C088...).
  // Each root message in the channel has a slack_list.list_record_id field
  // that maps directly to a record ID — no fuzzy timestamp matching needed.
  async function resolveListItemThreads(
    listId: string,
    items: Array<{ id: string; date_created?: number | string }>,
  ): Promise<Map<string, { channelId: string; threadTs: string }>> {
    const result = new Map<string, { channelId: string; threadTs: string }>();
    const listChannelId = listId.startsWith('F') ? 'C' + listId.slice(1) : null;
    if (!listChannelId || items.length === 0) return result;

    try {
      let minCreated = Infinity;
      let maxCreated = -Infinity;
      for (const item of items) {
        if (item.date_created != null) {
          const created = typeof item.date_created === 'number' ? item.date_created : parseInt(item.date_created);
          if (created < minCreated) minCreated = created;
          if (created > maxCreated) maxCreated = created;
        }
      }
      if (minCreated === Infinity) return result;

      const historyResult = await client.conversations.history({
        channel: listChannelId,
        oldest: String(minCreated - 5),
        latest: String(maxCreated + 5),
        limit: Math.max(items.length * 2, 10),
      });
      for (const msg of (historyResult.messages || []) as any[]) {
        const recordId = msg.slack_list?.list_record_id;
        if (recordId && msg.ts && !result.has(recordId)) {
          result.set(recordId, { channelId: listChannelId, threadTs: msg.ts });
        }
      }
    } catch (e) {
      logger.warn("Could not resolve list item threads", { listId, error: e });
    }
    return result;
  }

  return {
    list_channels: tool({
      description:
        "List Slack channels that Aura is currently a member of. Important: this only shows channels Aura has already joined, NOT all public channels in the workspace. To join a channel not shown here, use join_channel with the exact channel name or ID.",
      inputSchema: z.object({
        limit: z
          .number()
          .min(1)
          .max(200)
          .default(100)
          .describe("Maximum number of channels to return"),
      }),
      execute: async ({ limit }) => {
        try {
          const allChannels: Array<{
            name: string;
            id: string;
            topic: string;
            member_count: number;
            is_member: boolean;
          }> = [];

          let cursor: string | undefined;
          do {
            const result = await client.conversations.list({
              types: "public_channel,private_channel",
              exclude_archived: true,
              limit: 200,
              cursor,
            });

            for (const ch of result.channels || []) {
              allChannels.push({
                name: ch.name || "unknown",
                id: ch.id || "",
                topic: ch.topic?.value || "",
                member_count: ch.num_members || 0,
                is_member: ch.is_member || false,
              });
            }

            cursor = result.response_metadata?.next_cursor || undefined;
          } while (cursor && allChannels.length < limit);

          const capped = allChannels.slice(0, limit);

          logger.info("list_channels tool called", {
            count: capped.length,
          });

          return {
            ok: true,
            channels: capped,
            total: capped.length,
          };
        } catch (error: any) {
          logger.error("list_channels tool failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to list channels: ${error.message}`,
          };
        }
      },
    }),

    get_channel_info: tool({
      description:
        "Get detailed information about a Slack channel by name or ID. Returns the channel name, topic, purpose, privacy status, and member count. Works for any channel — not just ones Aura has joined. Use this to resolve a channel ID (like C0BNVKS77) to its human-readable name.",
      inputSchema: z.object({
        channel: z
          .string()
          .describe(
            "Channel name (e.g. 'general', '#general') or channel ID (e.g. 'C0BNVKS77')",
          ),
      }),
      execute: async ({ channel: channelInput }) => {
        try {
          const cleaned = channelInput.replace(/^#/, "").trim();

          // If it looks like a channel ID, resolve directly
          if (/^C[A-Z0-9]+$/.test(cleaned)) {
            const info = await resolveChannelById(client, cleaned);
            if (!info) {
              return {
                ok: false,
                error: `Could not find channel with ID "${cleaned}". The channel may not exist or may not be accessible.`,
              };
            }
            logger.info("get_channel_info tool called", { channel: cleaned, name: info.name });
            return { ok: true, channel: info };
          }

          // Name-based: resolve name to ID, then get full info
          const resolved = await resolveChannelByName(client, cleaned, { fallbackToUserToken: true });
          if (!resolved) {
            return {
              ok: false,
              error: `Could not find a channel named "${cleaned}". Use list_channels to see available channels, or try join_channel if it's a public channel.`,
            };
          }

          const info = await resolveChannelById(client, resolved.id);
          if (!info) {
            return { ok: true, channel: { id: resolved.id, name: resolved.name, is_private: false, topic: "", purpose: "", num_members: 0 } };
          }

          logger.info("get_channel_info tool called", { channel: channelInput, name: info.name });
          return { ok: true, channel: info };
        } catch (error: any) {
          logger.error("get_channel_info tool failed", { channel: channelInput, error: error.message });
          return { ok: false, error: `Failed to get channel info: ${error.message}` };
        }
      },
    }),

    search_channels: tool({
      description:
        "Search for Slack channels by partial name match. Returns matching channels from both joined and public channels. Useful when you don't know the exact channel name.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Partial channel name to search for, e.g. 'road' or 'dev'"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(20)
          .describe("Maximum number of results to return"),
      }),
      execute: async ({ query, limit }) => {
        try {
          const q = query.toLowerCase();
          const results: Array<{ id: string; name: string; topic: string; is_member: boolean }> = [];
          const seenIds = new Set<string>();

          // Search bot's channel cache first, resolving full metadata for topic
          const botChannels = await getChannelList(client);
          const matchingBotChannels = botChannels
            .filter((ch) => ch.name.toLowerCase().includes(q))
            .slice(0, limit);
          const resolvedInfos = await Promise.all(
            matchingBotChannels.map((ch) => resolveChannelById(client, ch.id)),
          );
          for (let i = 0; i < matchingBotChannels.length; i++) {
            const ch = matchingBotChannels[i];
            const info = resolvedInfos[i];
            results.push({ id: ch.id, name: ch.name, topic: info?.topic || "", is_member: true });
            seenIds.add(ch.id);
          }

          // Search all public channels via bot client for broader coverage
          if (results.length < limit) {
            let cursor: string | undefined;

            do {
              const result = await client.conversations.list({
                types: "public_channel",
                exclude_archived: true,
                limit: 200,
                cursor,
              });

              for (const ch of result.channels || []) {
                if (results.length >= limit) break;
                if (ch.id && ch.name && ch.name.toLowerCase().includes(q) && !seenIds.has(ch.id)) {
                  results.push({
                    id: ch.id,
                    name: ch.name,
                    topic: ch.topic?.value || "",
                    is_member: ch.is_member || false,
                  });
                  seenIds.add(ch.id);
                }
              }

              cursor = result.response_metadata?.next_cursor || undefined;
            } while (cursor && results.length < limit);
          }

          const capped = results.slice(0, limit);
          logger.info("search_channels tool called", { query, matchCount: capped.length });

          return {
            ok: true,
            query,
            results: capped,
            count: capped.length,
          };
        } catch (error: any) {
          logger.error("search_channels tool failed", { query, error: error.message });
          return { ok: false, error: `Failed to search channels: ${error.message}` };
        }
      },
    }),

    join_channel: tool({
      description:
        "Join a public Slack channel by name or ID. Aura must join a channel before she can read its history or post messages there. Only works for public channels. This tool can find and join channels that don't appear in list_channels results, since list_channels only shows channels Aura is already in.",
      inputSchema: z.object({
        channel: z
          .string()
          .describe(
            "Channel name (e.g. 'general') or channel ID (e.g. 'C0BNVKS77')",
          ),
      }),
      execute: async ({ channel: channelInput }) => {
        try {
          const channel = await resolveChannelByName(client, channelInput, {
            fallbackToUserToken: true,
          });
          if (!channel) {
            return {
              ok: false,
              error: `Could not find a channel named "${channelInput}". It may not exist or may be private. Use list_channels to see available channels.`,
            };
          }

          await client.conversations.join({ channel: channel.id });

          // Invalidate cache so subsequent calls see the newly joined channel
          channelCache = null;

          logger.info("join_channel tool called", {
            channel: channel.name,
            channelId: channel.id,
          });

          return {
            ok: true,
            message: `Joined #${channel.name}`,
            channel_id: channel.id,
          };
        } catch (error: any) {
          logger.error("join_channel tool failed", {
            channel: channelInput,
            error: error.message,
          });

          if (error.data?.error === "method_not_supported_for_channel_type") {
            return {
              ok: false,
              error: `Cannot join #${channelInput} — it's a private channel. Someone needs to invite me.`,
            };
          }

          return {
            ok: false,
            error: `Failed to join #${channelInput}: ${error.message}`,
          };
        }
      },
    }),

    read_channel_history: tool({
      description:
        "Read recent messages from a Slack channel. Aura must be a member of the channel. Use join_channel first if needed.",
      inputSchema: z.object({
        channel: z
          .string()
          .describe(
            "Channel name (e.g. 'general') or channel ID (e.g. 'C0BNVKS77')",
          ),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe("Number of recent messages to fetch (max 50)"),
      }),
      execute: async ({ channel: channelInput, limit }) => {
        try {
          const channel = await resolveChannelByName(client, channelInput);
          if (!channel) {
            return {
              ok: false,
              error: `Could not find a channel named "${channelInput}".`,
            };
          }

          const result = await client.conversations.history({
            channel: channel.id,
            limit,
          });

          // Resolve user IDs to display names
          const tz = context?.timezone;
          const messages = await Promise.all(
            (result.messages || []).map(async (msg) => {
              const userName = msg.user
                ? await resolveUserById(client, msg.user)
                : "unknown";
              const attachmentsSummary = generateAttachmentsSummary(msg);
              return {
                user: userName,
                text: extractFullMessageText(msg),
                ts: msg.ts || "",
                time: formatTimestamp(msg.ts, tz),
                ...(attachmentsSummary ? { attachments_summary: attachmentsSummary } : {}),
                reactions:
                  (msg as any).reactions?.map((r: any) => ({
                    name: r.name,
                    count: r.count,
                  })) || [],
              };
            }),
          );

          // Reverse so oldest is first (conversations.history returns newest first)
          messages.reverse();

          logger.info("read_channel_history tool called", {
            channel: channel.name,
            messageCount: messages.length,
          });

          return {
            ok: true,
            channel: channel.name,
            messages,
            count: messages.length,
          };
        } catch (error: any) {
          logger.error("read_channel_history tool failed", {
            channel: channelInput,
            error: error.message,
          });

          if (error.data?.error === "not_in_channel") {
            return {
              ok: false,
              error: `I'm not a member of #${channelInput}. Use join_channel to join it first.`,
            };
          }

          return {
            ok: false,
            error: `Failed to read #${channelInput}: ${error.message}`,
          };
        }
      },
    }),

    read_thread_replies: tool({
      description:
        "Read replies from a specific thread in a channel. Works for regular channel threads and Slack List item comment threads. Aura must be a member of the channel (except for list channels like C088REN54FM where posting access is implicit).",
      inputSchema: z.object({
        channel: z
          .string()
          .describe(
            "Channel name (e.g. 'general') or channel ID (e.g. 'C088REN54FM')",
          ),
        thread_ts: z
          .string()
          .describe("Timestamp of the parent/root message of the thread"),
        limit: z
          .number()
          .min(1)
          .max(200)
          .default(50)
          .describe("Max replies to fetch (default 50)"),
      }),
      execute: async ({ channel: channelInput, thread_ts, limit }) => {
        try {
          const channel = await resolveChannelByName(client, channelInput);
          if (!channel) {
            return {
              ok: false,
              error: `Could not find a channel named "${channelInput}".`,
            };
          }

          const threadResult = await client.conversations.replies({
            channel: channel.id,
            ts: thread_ts,
            limit: limit + 1,
          });

          const allMessages = threadResult.messages || [];
          // First message is the parent/root — skip it, return only replies
          const replyMessages = allMessages.slice(1);

          const replies = await Promise.all(
            replyMessages.map(async (reply) => {
              const userName = reply.user
                ? await resolveUserById(client, reply.user)
                : "unknown";
              const attachmentsSummary = generateAttachmentsSummary(reply);
              return {
                user: userName,
                user_id: reply.user || "",
                text: extractFullMessageText(reply),
                timestamp: reply.ts || "",
                ...(attachmentsSummary
                  ? { attachments_summary: attachmentsSummary }
                  : {}),
                reactions:
                  (reply as any).reactions?.map((r: any) => ({
                    name: r.name,
                    count: r.count,
                  })) || [],
              };
            }),
          );

          logger.info("read_thread_replies tool called", {
            channel: channel.name,
            thread_ts,
            replyCount: replies.length,
          });

          return {
            ok: true,
            channel: channel.name,
            thread_ts,
            replies,
            count: replies.length,
            has_more: threadResult.has_more || false,
          };
        } catch (error: any) {
          logger.error("read_thread_replies tool failed", {
            channel: channelInput,
            thread_ts,
            error: error.message,
          });

          if (error.data?.error === "not_in_channel") {
            return {
              ok: false,
              error: `I'm not a member of #${channelInput}. Use join_channel to join it first.`,
            };
          }

          return {
            ok: false,
            error: `Failed to read thread replies in #${channelInput}: ${error.message}`,
          };
        }
      },
    }),

    send_channel_message: tool({
      description:
        "Send a message to a Slack channel. Aura must be a member of the channel. Use join_channel first if needed.",
      inputSchema: z.object({
        channel: z
          .string()
          .describe(
            "Channel name (e.g. 'general') or channel ID (e.g. 'C0BNVKS77')",
          ),
        message: z
          .string()
          .describe(
            "The message text to send. Supports Slack mrkdwn formatting.",
          ),
      }),
      execute: async ({ channel: channelInput, message }) => {
        try {
          const channel = await resolveChannelByName(client, channelInput);
          if (!channel) {
            return {
              ok: false,
              error: `Could not find a channel named "${channelInput}".`,
            };
          }

          const result = await client.chat.postMessage({
            channel: channel.id,
            text: formatForSlack(message),
          });

          logger.info("send_channel_message tool called", {
            channel: channel.name,
            channelId: channel.id,
            messageTs: result.ts,
          });

          return {
            ok: true,
            message: `Message sent to #${channel.name}`,
            timestamp: result.ts,
          };
        } catch (error: any) {
          logger.error("send_channel_message tool failed", {
            channel: channelInput,
            error: error.message,
          });

          if (error.data?.error === "not_in_channel") {
            return {
              ok: false,
              error: `I'm not a member of #${channelInput}. Use join_channel to join it first, then try sending again.`,
            };
          }
          if (error.data?.error === "channel_not_found") {
            return {
              ok: false,
              error: `Channel #${channelInput} not found. Use list_channels to see available channels.`,
            };
          }

          return {
            ok: false,
            error: `Failed to send message to #${channelInput}: ${error.message}`,
          };
        }
      },
    }),

    list_users: tool({
      description:
        "List members of the Slack workspace. Returns display names, real names, usernames, and roles. Excludes deleted users and bots.",
      inputSchema: z.object({
        limit: z
          .number()
          .min(1)
          .max(200)
          .default(100)
          .describe("Maximum number of users to return"),
      }),
      execute: async ({ limit }) => {
        try {
          const allUsers = await getUserList(client);
          const users = allUsers.slice(0, limit).map((u) => ({
            display_name: u.displayName || u.realName || u.username,
            real_name: u.realName,
            username: u.username,
            id: u.id,
          }));

          logger.info("list_users tool called", { count: users.length });

          return {
            ok: true,
            users,
            total: allUsers.length,
            showing: users.length,
          };
        } catch (error: any) {
          logger.error("list_users tool failed", { error: error.message });
          return { ok: false, error: `Failed to list users: ${error.message}` };
        }
      },
    }),

    get_user_info: tool({
      description:
        "Get detailed profile information about a specific Slack user by their display name, real name, or username. Returns timezone, status, title, phone, email (if visible), and more.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, or username of the person to look up",
          ),
      }),
      execute: async ({ user_name }) => {
        try {
          const user = await resolveUserByName(client, user_name);
          if (!user) {
            return {
              ok: false,
              error: `Could not find a user named "${user_name}". Use list_users to see available members.`,
            };
          }

          const result = await client.users.info({ user: user.id });
          const u = result.user;

          if (!u) {
            return {
              ok: false,
              error: `Failed to fetch profile for ${user_name}.`,
            };
          }

          const profile = {
            id: u.id || "",
            display_name: u.profile?.display_name || "",
            real_name: u.real_name || "",
            username: u.name || "",
            title: u.profile?.title || "",
            status_text: u.profile?.status_text || "",
            status_emoji: u.profile?.status_emoji || "",
            timezone: u.tz || "",
            timezone_label: u.tz_label || "",
            email: u.profile?.email || "",
            phone: u.profile?.phone || "",
            is_admin: u.is_admin || false,
            is_owner: u.is_owner || false,
          };

          logger.info("get_user_info tool called", {
            user: user.name,
            userId: user.id,
          });

          return { ok: true, profile };
        } catch (error: any) {
          logger.error("get_user_info tool failed", {
            user_name,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to get info for ${user_name}: ${error.message}`,
          };
        }
      },
    }),

    search_users: tool({
      description:
        "Search for workspace members by partial name match. Useful when you don't know the exact name. Searches across display names, real names, and usernames.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Partial name to search for, e.g. 'joan' or 'rodriguez'"),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe("Maximum number of results to return"),
      }),
      execute: async ({ query, limit }) => {
        try {
          const allUsers = await getUserList(client);
          const q = query.toLowerCase();

          const matches = allUsers.filter(
            (u) =>
              u.displayName.toLowerCase().includes(q) ||
              u.realName.toLowerCase().includes(q) ||
              u.username.toLowerCase().includes(q),
          );

          const results = matches.slice(0, limit || 20).map((u) => ({
            display_name: u.displayName || u.realName || u.username,
            real_name: u.realName,
            username: u.username,
            id: u.id,
          }));

          logger.info("search_users tool called", {
            query,
            matchCount: results.length,
          });

          return {
            ok: true,
            query,
            results,
            count: results.length,
            total_matches: matches.length,
            has_more: matches.length > results.length,
          };
        } catch (error: any) {
          logger.error("search_users tool failed", {
            query,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to search users: ${error.message}`,
          };
        }
      },
    }),

    search_messages: tool({
      description:
        "Search for messages across the entire Slack workspace. Supports Slack's search syntax: use 'in:#channel' to filter by channel, 'from:@user' to filter by sender. Requires SLACK_USER_TOKEN to be configured.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Search query. Supports Slack search syntax like 'budget in:#finance from:@joan'",
          ),
        count: z
          .number()
          .min(1)
          .max(20)
          .default(10)
          .describe("Number of results to return (max 20)"),
      }),
      execute: async ({ query, count }) => {
        const searchClient = await getUserClient();
        if (!searchClient) {
          return {
            ok: false,
            error:
              "Message search requires a SLACK_USER_TOKEN environment variable (a user OAuth token with search:read scope). It's not currently configured.",
          };
        }

        try {
          const result = await searchClient.search.messages({
            query,
            count,
            sort: "timestamp",
            sort_dir: "desc",
          });

          const tz = context?.timezone;
          const matches = (result.messages?.matches || []).map((m: any) => ({
            user: m.username || m.user || "unknown",
            text: m.text || "",
            channel: m.channel?.name || "unknown",
            ts: m.ts || "",
            time: formatTimestamp(m.ts, tz),
            permalink: m.permalink || "",
          }));

          logger.info("search_messages tool called", {
            query,
            matchCount: matches.length,
          });

          return {
            ok: true,
            query,
            results: matches,
            count: matches.length,
          };
        } catch (error: any) {
          logger.error("search_messages tool failed", {
            query,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to search messages: ${error.message}`,
          };
        }
      },
    }),

    send_direct_message: tool({
      description:
        "Send a direct message to one user or a group of users. Pass a single name for a 1:1 DM, or an array of names to open/find a group DM (MPIM). Opens the conversation if it doesn't exist.",
      inputSchema: z.object({
        user_name: z
          .union([z.string(), z.array(z.string()).min(1)])
          .describe(
            "A single display name/username (e.g. 'Joan') for a 1:1 DM, or an array of names (e.g. ['Joan', 'Alex', 'Sam']) for a group DM.",
          ),
        message: z
          .string()
          .describe(
            "The message text to send. Supports Slack mrkdwn formatting.",
          ),
      }),
      execute: async ({ user_name, message }) => {
        try {
          const names = Array.isArray(user_name) ? user_name : [user_name];

          const resolved = await Promise.all(
            names.map(async (name) => ({
              name,
              user: await resolveUserByName(client, name),
            })),
          );

          const failed = resolved.filter((r) => !r.user);
          if (failed.length > 0) {
            const failedNames = failed.map((r) => `"${r.name}"`).join(", ");
            return {
              ok: false,
              error: `Could not find user(s): ${failedNames}. Make sure the names match their Slack display name, real name, or username.`,
            };
          }

          const users = resolved.map((r) => r.user!);
          const userIds = users.map((u) => u.id).join(",");

          const dmResult = await client.conversations.open({
            users: userIds,
          });

          const dmChannelId = dmResult.channel?.id;
          if (!dmChannelId) {
            const userNames = users.map((u) => u.name).join(", ");
            return {
              ok: false,
              error: `Failed to open a DM with ${userNames}.`,
            };
          }

          const result = await client.chat.postMessage({
            channel: dmChannelId,
            text: formatForSlack(message),
          });

          const isGroup = users.length > 1;
          const userNames = users.map((u) => u.name).join(", ");

          logger.info("send_direct_message tool called", {
            users: userNames,
            userIds: users.map((u) => u.id),
            isGroup,
            messageTs: result.ts,
          });

          return {
            ok: true,
            message: isGroup
              ? `Group DM sent to ${userNames}`
              : `Direct message sent to ${userNames}`,
            timestamp: result.ts,
          };
        } catch (error: any) {
          logger.error("send_direct_message tool failed", {
            user_name,
            error: error.message,
          });

          return {
            ok: false,
            error: `Failed to DM ${Array.isArray(user_name) ? user_name.join(", ") : user_name}: ${error.message}`,
          };
        }
      },
    }),

    read_dm_history: tool({
      description:
        "Read messages from a direct message conversation with a specific user. Supports optional time-window filtering via oldest_ts/latest_ts (Unix epoch seconds) so you can fetch only messages within a specific period (e.g. a single CET day). Use this to check past DM conversations, follow up on earlier messages, or compute per-user message counts for a time range.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, username, or user ID of the person whose DM history to read, e.g. 'Joan' or '@joan' or 'U066V1AN6'",
          ),
        limit: z
          .number()
          .min(1)
          .max(200)
          .default(20)
          .describe("Maximum number of messages to fetch (max 200). Acts as a safety cap when combined with time-window params."),
        oldest_ts: z
          .string()
          .optional()
          .describe(
            "Only return messages after this Unix timestamp (inclusive, seconds with optional decimals). E.g. '1718920800' for a specific epoch time.",
          ),
        latest_ts: z
          .string()
          .optional()
          .describe(
            "Only return messages before this Unix timestamp (inclusive, seconds with optional decimals). E.g. '1719007200' for a specific epoch time.",
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            "Pagination cursor from a previous response's next_cursor field. Omit to start from the beginning.",
          ),
      }),
      execute: async ({ user_name, limit, oldest_ts, latest_ts, cursor: inputCursor }) => {
        try {
          const user = await resolveUserByName(client, user_name);
          if (!user) {
            return {
              ok: false,
              error: `Could not find a user named "${user_name}". Use list_users or search_users to find the right name.`,
            };
          }

          // Find existing DM channel without creating a new one
          let dmChannelId: string | undefined;
          let imCursor: string | undefined;

          do {
            const imResult = await client.conversations.list({
              types: "im",
              limit: 200,
              cursor: imCursor,
            });

            for (const ch of imResult.channels || []) {
              if (ch.user === user.id && ch.id) {
                dmChannelId = ch.id;
                break;
              }
            }

            if (dmChannelId) break;
            imCursor = imResult.response_metadata?.next_cursor || undefined;
          } while (imCursor);

          if (!dmChannelId) {
            return {
              ok: true,
              user: user.name,
              user_id: user.id,
              messages: [],
              count: 0,
              note: "No prior DM conversation exists with this user.",
            };
          }

          // Fetch conversation history with optional time-window
          const historyParams: Record<string, unknown> = {
            channel: dmChannelId,
            limit,
          };
          if (oldest_ts) historyParams.oldest = oldest_ts;
          if (latest_ts) historyParams.latest = latest_ts;
          if (oldest_ts || latest_ts) historyParams.inclusive = true;
          if (inputCursor) historyParams.cursor = inputCursor;

          const result = await client.conversations.history(historyParams as any);

          // Resolve user IDs to display names, and fetch thread replies for threaded messages
          const tz = context?.timezone;
          const messages = await Promise.all(
            (result.messages || []).map(async (msg) => {
              const userName = msg.user
                ? await resolveUserById(client, msg.user)
                : "unknown";

              const replyCount = (msg as any).reply_count as number | undefined;
              const threadTs = msg.ts || "";
              const latestReply = (msg as any).latest_reply as string | undefined;

              let replies: Array<{ user: string; user_id: string; text: string; ts: string; time: string }> | undefined;

              if (replyCount && replyCount > 0 && threadTs) {
                try {
                  const threadResult = await client.conversations.replies({
                    channel: dmChannelId!,
                    ts: threadTs,
                    limit: 200,
                  });
                  // First message in replies is the parent — skip it
                  const threadMessages = (threadResult.messages || []).slice(1);
                  replies = await Promise.all(
                    threadMessages.map(async (reply) => {
                      const replyUserName = reply.user
                        ? await resolveUserById(client, reply.user)
                        : "unknown";
                      return {
                        user: replyUserName,
                        user_id: reply.user || "",
                        text: extractFullMessageText(reply),
                        ts: reply.ts || "",
                        time: formatTimestamp(reply.ts, tz),
                      };
                    }),
                  );
                } catch (threadError: any) {
                  logger.error("Failed to fetch thread replies", {
                    channel: dmChannelId,
                    thread_ts: threadTs,
                    error: threadError.message,
                  });
                }
              }

              const attachmentsSummary = generateAttachmentsSummary(msg);
              return {
                user: userName,
                user_id: msg.user || "",
                text: extractFullMessageText(msg),
                ts: msg.ts || "",
                time: formatTimestamp(msg.ts, tz),
                ...(attachmentsSummary ? { attachments_summary: attachmentsSummary } : {}),
                ...(replyCount != null && replyCount > 0
                  ? { reply_count: replyCount, thread_ts: threadTs, latest_reply: latestReply }
                  : {}),
                ...(replies && replies.length > 0 ? { replies } : {}),
                reactions:
                  (msg as any).reactions?.map((r: any) => ({
                    name: r.name,
                    count: r.count,
                  })) || [],
              };
            }),
          );

          logger.info("read_dm_history tool called", {
            user: user.name,
            userId: user.id,
            dmChannelId,
            messageCount: messages.length,
            oldest_ts,
            latest_ts,
          });

          const nextCursor = result.response_metadata?.next_cursor || null;

          return {
            ok: true,
            user: user.name,
            user_id: user.id,
            dm_channel_id: dmChannelId,
            messages,
            count: messages.length,
            has_more: result.has_more || false,
            next_cursor: nextCursor,
          };
        } catch (error: any) {
          logger.error("read_dm_history tool failed", {
            user_name,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to read DM history with ${user_name}: ${error.message}`,
          };
        }
      },
    }),

    list_dm_conversations: tool({
      description:
        "List DM conversations Aura has had. Returns the list of users Aura has open DM channels with. Supports cursor pagination — pass the returned next_cursor to fetch subsequent pages and enumerate ALL DM channels. Admin-only.",
      inputSchema: z.object({
        limit: z
          .number()
          .min(1)
          .max(200)
          .default(20)
          .describe("Maximum number of DM conversations to return per page (max 200)"),
        cursor: z
          .string()
          .optional()
          .describe(
            "Pagination cursor from a previous response's next_cursor field. Omit to start from the beginning.",
          ),
      }),
      execute: async ({ limit, cursor: inputCursor }) => {
        try {
          // Authorization: only admins can list all DM conversations
          if (!isAdmin(context?.userId) && context?.userId !== "aura") {
            return {
              ok: false,
              error:
                "Only admins can list all DM conversations. Use read_dm_history to check your own DM with Aura.",
            };
          }

          // Pre-load user list to avoid N+1 API calls for name resolution
          const allUsers = await getUserList(client);
          const userNameMap = new Map<string, string>();
          for (const u of allUsers) {
            userNameMap.set(
              u.id,
              u.displayName || u.realName || u.username || u.id,
            );
          }

          const result = await client.conversations.list({
            types: "im",
            exclude_archived: true,
            limit,
            ...(inputCursor ? { cursor: inputCursor } : {}),
          });

          const tz = context?.timezone;
          const conversations: Array<{
            user_name: string;
            user_id: string;
            dm_channel_id: string;
            last_message_preview: string;
            last_activity_ts: string;
            last_activity_time: string;
          }> = [];

          for (const ch of result.channels || []) {
            if (!ch.id || !ch.user) continue;

            const userName = userNameMap.get(ch.user) || ch.user;
            const updated = (ch as any).updated;
            const rawTs =
              typeof updated === "number" && updated > 0
                ? String(updated)
                : "";
            conversations.push({
              user_name: userName,
              user_id: ch.user,
              dm_channel_id: ch.id,
              last_message_preview: "",
              last_activity_ts: rawTs,
              last_activity_time: formatTimestamp(rawTs, tz),
            });
          }

          const nextCursor = result.response_metadata?.next_cursor || null;

          logger.info("list_dm_conversations tool called", {
            count: conversations.length,
            has_more: !!nextCursor,
          });

          return {
            ok: true,
            conversations,
            count: conversations.length,
            next_cursor: nextCursor,
          };
        } catch (error: any) {
          logger.error("list_dm_conversations tool failed", {
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to list DM conversations: ${error.message}`,
          };
        }
      },
    }),

    // ── Slack Lists Tools ──────────────────────────────────────────────────

    list_slack_list_items: tool({
      description:
        "Retrieve items (rows) from a Slack List. Use this to read bug trackers, project lists, task lists, or any Slack List. Requires the list ID.",
      inputSchema: z.object({
        list_id: z
          .string()
          .describe("The ID of the Slack List to read items from"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(50)
          .describe("Maximum number of items to return"),
        cursor: z
          .string()
          .optional()
          .describe(
            "Pagination cursor from a previous response's next_cursor field",
          ),
      }),
      execute: async ({ list_id, limit, cursor }) => {
        try {
          const result = await (client as any).apiCall(
            "slackLists.items.list",
            {
              list_id,
              limit,
              ...(cursor ? { cursor } : {}),
            },
          );

          if (!result.ok) {
            return {
              ok: false,
              error: `Failed to read list: ${result.error || "unknown error"}`,
            };
          }

          logger.info("list_slack_list_items tool called", {
            list_id,
            itemCount: result.items?.length || 0,
          });

          const itemsRaw = result.items || [];
          const threadMap = await resolveListItemThreads(list_id, itemsRaw);

          const items = itemsRaw.map((item: any) => {
            const thread = threadMap.get(item.id);
            return {
              ...item,
              thread_channel_id: thread?.channelId ?? null,
              thread_ts: thread?.threadTs ?? null,
            };
          });

          return {
            ok: true,
            list_id,
            items,
            count: items.length,
            next_cursor: result.response_metadata?.next_cursor || null,
          };
        } catch (error: any) {
          logger.error("list_slack_list_items tool failed", {
            list_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to read list items: ${error.message}`,
          };
        }
      },
    }),

    get_slack_list_item: tool({
      description:
        "Get details about a specific item (row) in a Slack List by its record ID. Returns all fields/columns for that item.",
      inputSchema: z.object({
        list_id: z.string().describe("The ID of the Slack List"),
        item_id: z
          .string()
          .describe("The ID of the specific item/record to retrieve"),
      }),
      execute: async ({ list_id, item_id }) => {
        try {
          const result = await (client as any).apiCall(
            "slackLists.items.info",
            {
              list_id,
              id: item_id,
            },
          );

          if (!result.ok) {
            return {
              ok: false,
              error: `Failed to read list item: ${result.error || "unknown error"}`,
            };
          }

          logger.info("get_slack_list_item tool called", {
            list_id,
            item_id,
          });

          const raw = result.record || result.item;

          let threadChannelId: string | null = null;
          let threadTs: string | null = null;
          if (raw?.id) {
            const threadMap = await resolveListItemThreads(list_id, [raw]);
            const thread = threadMap.get(raw.id);
            if (thread) {
              threadChannelId = thread.channelId;
              threadTs = thread.threadTs;
            }
          }

          const item = raw
            ? {
                ...raw,
                thread_channel_id: threadChannelId,
                thread_ts: threadTs,
              }
            : null;

          return {
            ok: true,
            item,
          };
        } catch (error: any) {
          logger.error("get_slack_list_item tool failed", {
            list_id,
            item_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to get list item: ${error.message}`,
          };
        }
      },
    }),

    // ── Canvas Tools ───────────────────────────────────────────────────────

    read_canvas: tool({
      description:
        "Read the content of a Slack Canvas by looking up its sections. Returns the canvas structure and content.",
      inputSchema: z.object({
        canvas_id: z.string().describe("The ID of the Canvas to read"),
      }),
      execute: async ({ canvas_id }) => {
        try {
          const result = await (client as any).apiCall(
            "canvases.sections.lookup",
            {
              canvas_id,
              criteria: {},
            },
          );

          if (!result.ok) {
            return {
              ok: false,
              error: `Failed to read canvas: ${result.error || "unknown error"}`,
            };
          }

          logger.info("read_canvas tool called", { canvas_id });

          return {
            ok: true,
            canvas_id,
            sections: result.sections || [],
          };
        } catch (error: any) {
          logger.error("read_canvas tool failed", {
            canvas_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to read canvas: ${error.message}`,
          };
        }
      },
    }),

    create_canvas: tool({
      description:
        "Create a new Slack Canvas with a title and markdown content. Can optionally be added to a channel.",
      inputSchema: z.object({
        title: z.string().describe("Title for the new canvas"),
        content: z.string().describe("Markdown content for the canvas body"),
        channel_name: z
          .string()
          .optional()
          .describe("Optional channel name to add the canvas to as a tab"),
      }),
      execute: async ({ title, content, channel_name }) => {
        try {
          const params: any = {
            title,
            document_content: {
              type: "markdown",
              markdown: content,
            },
          };

          // If a channel is specified, add the canvas to it
          if (channel_name) {
            const channel = await resolveChannelByName(client, channel_name);
            if (channel) {
              params.channel_id = channel.id;
            }
          }

          const result = await (client as any).apiCall(
            "canvases.create",
            params,
          );

          if (!result.ok) {
            return {
              ok: false,
              error: `Failed to create canvas: ${result.error || "unknown error"}`,
            };
          }

          logger.info("create_canvas tool called", {
            title,
            canvasId: result.canvas_id,
            channel: channel_name,
          });

          return {
            ok: true,
            canvas_id: result.canvas_id,
            message: channel_name
              ? `Canvas "${title}" created and added to #${channel_name}`
              : `Canvas "${title}" created`,
          };
        } catch (error: any) {
          logger.error("create_canvas tool failed", {
            title,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to create canvas: ${error.message}`,
          };
        }
      },
    }),

    edit_canvas: tool({
      description:
        "Edit an existing Slack Canvas. Supports inserting content at start/end or before/after a section, replacing or deleting a section, or renaming the canvas.",
      inputSchema: z.object({
        canvas_id: z.string().describe("The ID of the Canvas to edit"),
        operation: z
          .enum([
            "insert_at_end",
            "insert_at_start",
            "insert_before",
            "insert_after",
            "replace",
            "delete",
            "rename",
          ])
          .describe("The type of edit operation to perform"),
        content: z
          .string()
          .optional()
          .describe(
            "Markdown content to insert/replace, or the new title for rename. Not needed for delete.",
          ),
        section_id: z
          .string()
          .optional()
          .describe(
            "Section ID (required for replace, delete, insert_before, insert_after). Use read_canvas to find section IDs.",
          ),
      }),
      execute: async ({ canvas_id, operation, content, section_id }) => {
        try {
          let changes: any[];

          if (operation === "rename") {
            if (!content) {
              return { ok: false, error: "Content (new title) is required for rename operations." };
            }
            changes = [
              {
                operation: "rename",
                title_content: { type: "markdown", markdown: content },
              },
            ];
          } else if (operation === "delete") {
            if (!section_id) {
              return {
                ok: false,
                error: "Section ID is required for delete operations. Use read_canvas to find section IDs.",
              };
            }
            changes = [{ operation: "delete", section_id }];
          } else if (
            operation === "replace" ||
            operation === "insert_before" ||
            operation === "insert_after"
          ) {
            if (!section_id) {
              return {
                ok: false,
                error: `Section ID is required for ${operation} operations. Use read_canvas to find section IDs.`,
              };
            }
            if (!content) {
              return { ok: false, error: `Content is required for ${operation} operations.` };
            }
            changes = [
              {
                operation,
                section_id,
                document_content: { type: "markdown", markdown: content },
              },
            ];
          } else {
            if (!content) {
              return { ok: false, error: `Content is required for ${operation} operations.` };
            }
            changes = [
              {
                operation,
                document_content: { type: "markdown", markdown: content },
              },
            ];
          }

          const result = await (client as any).apiCall("canvases.edit", {
            canvas_id,
            changes,
          });

          if (!result.ok) {
            return {
              ok: false,
              error: `Failed to edit canvas: ${result.error || "unknown error"}`,
            };
          }

          logger.info("edit_canvas tool called", {
            canvas_id,
            operation,
          });

          return {
            ok: true,
            message: `Canvas updated (${operation})`,
          };
        } catch (error: any) {
          logger.error("edit_canvas tool failed", {
            canvas_id,
            operation,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to edit canvas: ${error.message}`,
          };
        }
      },
    }),

    delete_canvas: tool({
      description:
        "Delete a Slack Canvas permanently by its canvas/file ID.",
      inputSchema: z.object({
        canvas_id: z
          .string()
          .describe("The canvas ID (e.g. 'F0AFVJRES9M')"),
      }),
      execute: async ({ canvas_id }) => {
        try {
          const result = await (client as any).apiCall("canvases.delete", {
            canvas_id,
          });

          if (!result.ok) {
            return {
              ok: false,
              error: `Failed to delete canvas: ${result.error || "unknown error"}`,
            };
          }

          logger.info("delete_canvas tool called", { canvas_id });
          return { ok: true, message: `Canvas ${canvas_id} deleted` };
        } catch (error: any) {
          logger.error("delete_canvas tool failed", {
            canvas_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to delete canvas: ${error.message}`,
          };
        }
      },
    }),

    share_canvas: tool({
      description:
        "Share a canvas with users or channels. Set access level (read, write, or owner).",
      inputSchema: z.object({
        canvas_id: z.string().describe("The canvas ID"),
        access_level: z
          .enum(["read", "write", "owner"])
          .default("write")
          .describe("Access level to grant"),
        user_ids: z
          .array(z.string())
          .optional()
          .describe("User IDs to share with"),
        channel_ids: z
          .array(z.string())
          .optional()
          .describe("Channel IDs to share with"),
      }),
      execute: async ({ canvas_id, access_level, user_ids, channel_ids }) => {
        try {
          if (!user_ids?.length && !channel_ids?.length) {
            return {
              ok: false,
              error:
                "At least one user_id or channel_id is required to share with.",
            };
          }

          if (access_level === "owner" && channel_ids?.length) {
            return {
              ok: false,
              error:
                "access_level 'owner' can only be granted to users (user_ids), not channels.",
            };
          }

          // user_ids and channel_ids are mutually exclusive in the API,
          // so make separate calls when both are provided
          let usersShared = false;

          if (user_ids?.length) {
            const userResult = await (client as any).apiCall(
              "canvases.access.set",
              { canvas_id, access_level, user_ids },
            );
            if (!userResult.ok) {
              return {
                ok: false,
                error: `Failed to share canvas with users: ${userResult.error || "unknown error"}`,
              };
            }
            usersShared = true;
          }

          if (channel_ids?.length) {
            const channelResult = await (client as any).apiCall(
              "canvases.access.set",
              { canvas_id, access_level, channel_ids },
            );
            if (!channelResult.ok) {
              return {
                ok: false,
                error: `Failed to share canvas with channels: ${channelResult.error || "unknown error"}`,
                partial_success: usersShared
                  ? "Users were successfully shared before channel sharing failed."
                  : undefined,
              };
            }
          }

          logger.info("share_canvas tool called", {
            canvas_id,
            access_level,
            user_ids,
            channel_ids,
          });
          return {
            ok: true,
            message: `Canvas shared with ${access_level} access`,
          };
        } catch (error: any) {
          logger.error("share_canvas tool failed", {
            canvas_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to share canvas: ${error.message}`,
          };
        }
      },
    }),

    list_canvases: tool({
      description:
        "List canvases in the workspace. Uses files.list with a canvas type filter.",
      inputSchema: z.object({
        channel: z
          .string()
          .optional()
          .describe("Filter by channel ID"),
        count: z.number().default(20).describe("Max results to return"),
      }),
      execute: async ({ channel, count }) => {
        try {
          const result = await (client as any).apiCall("files.list", {
            types: "spaces",
            count,
            ...(channel && { channel }),
          });

          if (!result.ok) {
            return {
              ok: false,
              error: `Failed to list canvases: ${result.error || "unknown error"}`,
            };
          }

          logger.info("list_canvases tool called", { channel, count });
          return {
            ok: true,
            files: (result as any).files || [],
          };
        } catch (error: any) {
          logger.error("list_canvases tool failed", {
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to list canvases: ${error.message}`,
          };
        }
      },
    }),

    // ── File Upload Tools ─────────────────────────────────────────────────

    upload_file: tool({
      description:
        "Upload a file to Slack. Can share it to a channel or thread. Supports text files (CSV, JSON, code, etc.) and binary files (images, PDFs) via base64 encoding.",
      inputSchema: z.object({
        content: z
          .string()
          .describe(
            "File content. For text files, raw text. For binary files, base64-encoded string (set is_binary=true).",
          ),
        filename: z
          .string()
          .describe("Filename with extension, e.g. 'report.csv', 'chart.png'"),
        channel: z
          .string()
          .optional()
          .describe(
            "Channel name or ID to share the file to. If omitted, the file is uploaded but not shared to any channel.",
          ),
        title: z
          .string()
          .optional()
          .describe("Display title for the file in Slack"),
        is_binary: z
          .boolean()
          .default(false)
          .describe(
            "If true, decode content from base64 before uploading. Use for images, PDFs, and other binary files.",
          ),
        thread_ts: z
          .string()
          .optional()
          .describe(
            "Thread timestamp to attach the file to a specific thread",
          ),
      }),
      execute: async ({ content, filename, channel, title, is_binary, thread_ts }) => {
        try {
          const fileBuffer = is_binary
            ? Buffer.from(content, "base64")
            : Buffer.from(content, "utf-8");

          const uploadParams: Record<string, unknown> = {
            file: fileBuffer,
            filename,
          };

          if (title) uploadParams.title = title;

          if (thread_ts && !channel) {
            return {
              ok: false,
              error:
                "thread_ts requires a channel — provide the channel where the thread lives.",
            };
          }

          if (channel) {
            let channelId = channel;
            if (!/^[CG][A-Z0-9]+$/.test(channel)) {
              const resolved = await resolveChannelByName(client, channel);
              if (!resolved) {
                return {
                  ok: false,
                  error: `Could not find a channel named "${channel}". Use list_channels to see available channels.`,
                };
              }
              channelId = resolved.id;
            }
            uploadParams.channel_id = channelId;
            if (thread_ts) uploadParams.thread_ts = thread_ts;
          }

          const result = await client.filesUploadV2(uploadParams as any);
          const file = (result as any).file ?? (result as any).files?.[0];
          const fileId = file?.id ?? null;
          const fileUrl = file?.permalink ?? file?.url_private ?? null;

          logger.info("upload_file tool called", {
            filename,
            channel,
            fileId,
          });

          return {
            ok: true,
            file_id: fileId,
            file_url: fileUrl,
          };
        } catch (error: any) {
          logger.error("upload_file tool failed", {
            filename,
            channel,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to upload file: ${error.message}`,
          };
        }
      },
    }),

    // ── Message Management Tools ──────────────────────────────────────────

    edit_message: tool({
      description:
        "Edit one of Aura's own messages. Bots can only edit their own messages.",
      inputSchema: z.object({
        channel: z
          .string()
          .describe(
            "Channel name (e.g. 'general') or channel ID (e.g. 'C0BNVKS77')",
          ),
        message_ts: z.string().describe("Timestamp of the message to edit"),
        new_text: z.string().describe("The new message text"),
      }),
      execute: async ({ channel: channelInput, message_ts, new_text }) => {
        try {
          const channel = await resolveChannelByName(client, channelInput);
          if (!channel)
            return { ok: false, error: `Channel "${channelInput}" not found.` };
          await client.chat.update({
            channel: channel.id,
            ts: message_ts,
            text: formatForSlack(new_text),
          });
          logger.info("edit_message tool called", {
            channel: channel.name,
            ts: message_ts,
          });
          return { ok: true, message: `Message updated in #${channel.name}` };
        } catch (error: any) {
          logger.error("edit_message tool failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to edit message: ${error.message}`,
          };
        }
      },
    }),

    delete_message: tool({
      description:
        "Delete one of Aura's own messages. Bots can only delete their own messages.",
      inputSchema: z.object({
        channel: z
          .string()
          .describe(
            "Channel name (e.g. 'general') or channel ID (e.g. 'C0BNVKS77')",
          ),
        message_ts: z.string().describe("Timestamp of the message to delete"),
      }),
      execute: async ({ channel: channelInput, message_ts }) => {
        try {
          const channel = await resolveChannelByName(client, channelInput);
          if (!channel)
            return { ok: false, error: `Channel "${channelInput}" not found.` };
          await client.chat.delete({ channel: channel.id, ts: message_ts });
          logger.info("delete_message tool called", {
            channel: channel.name,
            ts: message_ts,
          });
          return { ok: true, message: `Message deleted from #${channel.name}` };
        } catch (error: any) {
          logger.error("delete_message tool failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to delete message: ${error.message}`,
          };
        }
      },
    }),

    send_thread_reply: tool({
      description:
        "Reply in a specific thread in a channel. Use this instead of send_channel_message when you want to respond in a thread. Also used to comment on Slack List items — each List item has an associated channel_id and ts, so pass those here.",
      inputSchema: z.object({
        channel: z
          .string()
          .describe(
            "Channel name (e.g. 'general') or channel ID (e.g. 'C0BNVKS77')",
          ),
        thread_ts: z
          .string()
          .describe("Timestamp of the parent message (thread)"),
        message: z.string().describe("The reply text"),
      }),
      execute: async ({ channel: channelInput, thread_ts, message }) => {
        try {
          const channel = await resolveChannelByName(client, channelInput);
          if (!channel)
            return { ok: false, error: `Channel "${channelInput}" not found.` };
          const result = await client.chat.postMessage({
            channel: channel.id,
            text: formatForSlack(message),
            thread_ts,
          });
          logger.info("send_thread_reply tool called", {
            channel: channel.name,
            thread_ts,
          });
          return {
            ok: true,
            message: `Reply sent in thread in #${channel.name}`,
            timestamp: result.ts,
          };
        } catch (error: any) {
          logger.error("send_thread_reply tool failed", {
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to send thread reply: ${error.message}`,
          };
        }
      },
    }),

    // ── Reaction Tools ──────────────────────────────────────────────────────

    add_reaction: tool({
      description:
        "Add an emoji reaction to a message. Use this to acknowledge, vote, triage, or signal without a full text reply.",
      inputSchema: z.object({
        channel: z
          .string()
          .describe(
            "Channel name (e.g. 'general') or channel ID (e.g. 'C0BNVKS77')",
          ),
        message_ts: z.string().describe("Timestamp of the message to react to"),
        emoji: z
          .string()
          .describe(
            "Emoji name without colons, e.g. 'eyes', 'white_check_mark', 'thumbsup'",
          ),
      }),
      execute: async ({ channel: channelInput, message_ts, emoji }) => {
        try {
          const channel = await resolveChannelByName(client, channelInput);
          if (!channel)
            return { ok: false, error: `Channel "${channelInput}" not found.` };
          await client.reactions.add({
            channel: channel.id,
            timestamp: message_ts,
            name: emoji,
          });
          logger.info("add_reaction tool called", {
            channel: channel.name,
            emoji,
          });
          return {
            ok: true,
            message: `Reacted with :${emoji}: in #${channel.name}`,
          };
        } catch (error: any) {
          logger.error("add_reaction tool failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to add reaction: ${error.message}`,
          };
        }
      },
    }),

    remove_reaction: tool({
      description: "Remove an emoji reaction from a message.",
      inputSchema: z.object({
        channel: z
          .string()
          .describe(
            "Channel name (e.g. 'general') or channel ID (e.g. 'C0BNVKS77')",
          ),
        message_ts: z.string().describe("Timestamp of the message"),
        emoji: z.string().describe("Emoji name without colons"),
      }),
      execute: async ({ channel: channelInput, message_ts, emoji }) => {
        try {
          const channel = await resolveChannelByName(client, channelInput);
          if (!channel)
            return { ok: false, error: `Channel "${channelInput}" not found.` };
          await client.reactions.remove({
            channel: channel.id,
            timestamp: message_ts,
            name: emoji,
          });
          logger.info("remove_reaction tool called", {
            channel: channel.name,
            emoji,
          });
          return {
            ok: true,
            message: `Removed :${emoji}: from message in #${channel.name}`,
          };
        } catch (error: any) {
          logger.error("remove_reaction tool failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to remove reaction: ${error.message}`,
          };
        }
      },
    }),

    // ── Channel Management Tools ────────────────────────────────────────────

    create_channel: tool({
      description: "Create a new Slack channel.",
      inputSchema: z.object({
        channel_name: z
          .string()
          .describe(
            "Name for the new channel (lowercase, hyphens, underscores only)",
          ),
        is_private: z
          .boolean()
          .default(false)
          .describe("Create as a private channel"),
      }),
      execute: async ({ channel_name, is_private }) => {
        try {
          const result = await client.conversations.create({
            name: channel_name.toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
            is_private,
          });
          const ch = result.channel as any;
          // Invalidate channel cache
          channelCache = null;
          logger.info("create_channel tool called", {
            channel: ch?.name,
            id: ch?.id,
          });
          return {
            ok: true,
            message: `Created ${is_private ? "private" : "public"} channel #${ch?.name}`,
            channel_id: ch?.id,
          };
        } catch (error: any) {
          logger.error("create_channel tool failed", { error: error.message });
          if (error.data?.error === "name_taken") {
            return {
              ok: false,
              error: `A channel named "${channel_name}" already exists.`,
            };
          }
          return {
            ok: false,
            error: `Failed to create channel: ${error.message}`,
          };
        }
      },
    }),

    set_channel_topic: tool({
      description:
        "Set or update a channel's topic. Aura must be a member of the channel.",
      inputSchema: z.object({
        channel: z
          .string()
          .describe(
            "Channel name (e.g. 'general') or channel ID (e.g. 'C0BNVKS77')",
          ),
        topic: z.string().describe("The new topic text"),
      }),
      execute: async ({ channel: channelInput, topic }) => {
        try {
          const channel = await resolveChannelByName(client, channelInput);
          if (!channel)
            return { ok: false, error: `Channel "${channelInput}" not found.` };
          await client.conversations.setTopic({ channel: channel.id, topic });
          channelIdNameCache.delete(channel.id);
          logger.info("set_channel_topic tool called", {
            channel: channel.name,
          });
          return { ok: true, message: `Topic updated for #${channel.name}` };
        } catch (error: any) {
          logger.error("set_channel_topic tool failed", {
            error: error.message,
          });
          return { ok: false, error: `Failed to set topic: ${error.message}` };
        }
      },
    }),

    invite_to_channel: tool({
      description:
        "Invite a user to a channel. Aura must be a member of the channel.",
      inputSchema: z.object({
        channel: z
          .string()
          .describe(
            "Channel name (e.g. 'general') or channel ID (e.g. 'C0BNVKS77')",
          ),
        user_name: z
          .string()
          .describe(
            "Display name, username, or user ID of the person to invite",
          ),
      }),
      execute: async ({ channel: channelInput, user_name }) => {
        try {
          const channel = await resolveChannelByName(client, channelInput);
          if (!channel)
            return { ok: false, error: `Channel "${channelInput}" not found.` };
          const user = await resolveUserByName(client, user_name);
          if (!user)
            return { ok: false, error: `User "${user_name}" not found.` };
          await client.conversations.invite({
            channel: channel.id,
            users: user.id,
          });
          logger.info("invite_to_channel tool called", {
            channel: channel.name,
            user: user.name,
          });
          return {
            ok: true,
            message: `Invited ${user.name} to #${channel.name}`,
          };
        } catch (error: any) {
          logger.error("invite_to_channel tool failed", {
            error: error.message,
          });
          if (error.data?.error === "already_in_channel") {
            return {
              ok: false,
              error: `${user_name} is already in #${channelInput}.`,
            };
          }
          return { ok: false, error: `Failed to invite: ${error.message}` };
        }
      },
    }),

    leave_channel: tool({
      description: "Leave a channel Aura is currently a member of.",
      inputSchema: z.object({
        channel: z
          .string()
          .describe(
            "Channel name (e.g. 'general') or channel ID (e.g. 'C0BNVKS77')",
          ),
      }),
      execute: async ({ channel: channelInput }) => {
        try {
          const channel = await resolveChannelByName(client, channelInput);
          if (!channel)
            return { ok: false, error: `Channel "${channelInput}" not found.` };
          await client.conversations.leave({ channel: channel.id });
          channelCache = null; // invalidate
          logger.info("leave_channel tool called", { channel: channel.name });
          return { ok: true, message: `Left #${channel.name}` };
        } catch (error: any) {
          logger.error("leave_channel tool failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to leave channel: ${error.message}`,
          };
        }
      },
    }),

    // ── Status Tool ─────────────────────────────────────────────────────────

    set_my_status: tool({
      description:
        "Set Aura's own Slack status. Use this to signal what you're doing (e.g. 'Running morning digest', 'Monitoring #bugs').",
      inputSchema: z.object({
        status_text: z
          .string()
          .describe("Status text, e.g. 'Running morning digest'"),
        status_emoji: z
          .string()
          .describe("Status emoji, e.g. ':mag:' or ':robot_face:'"),
        expiration_minutes: z
          .number()
          .optional()
          .describe("Auto-clear the status after this many minutes"),
      }),
      execute: async ({ status_text, status_emoji, expiration_minutes }) => {
        try {
          const profile: any = { status_text, status_emoji };
          if (expiration_minutes) {
            profile.status_expiration =
              Math.floor(Date.now() / 1000) + expiration_minutes * 60;
          }
          await client.users.profile.set({ profile });
          logger.info("set_my_status tool called", {
            status_text,
            status_emoji,
          });
          return {
            ok: true,
            message: `Status set to ${status_emoji} ${status_text}`,
          };
        } catch (error: any) {
          logger.error("set_my_status tool failed", { error: error.message });
          return { ok: false, error: `Failed to set status: ${error.message}` };
        }
      },
    }),

    // ── Slack Lists Write Tools ────────────────────────────────────────────
    ...createListWriteTools(client),

    // ── Note / Scratchpad Tools (with context for checkpoint_plan routing) ─
    ...createNoteTools(context),

    // ── Job Tools (unified: one-shots, recurring, continuations) ─────────
    ...createJobTools(client, context),

    // ── Web Tools ────────────────────────────────────────────────────────
    ...createWebTools(),

    // ── Sandbox Tools ────────────────────────────────────────────────────
    ...createSandboxTools(context),

    // ── BigQuery Tools ────────────────────────────────────────────────────
    ...createBigQueryTools(context),

    // ── Email Tools (Gmail) ──────────────────────────────────────────────
    ...createEmailTools(),
    ...createGmailEATools(),

    // ── Google Sheets Tools ───────────────────────────────────────────────
    ...createSheetsTools(),

    // ── Table Tools (native Slack table blocks) ──────────────────────────
    ...createTableTools(client, context),

    // ── Cursor Agent Tools (async code agent dispatch) ──────────────────
    ...createCursorAgentTools(context),

    // ── Conversation Search Tools (search stored messages DB) ─────────
    ...createConversationSearchTools(context),
  };
}
