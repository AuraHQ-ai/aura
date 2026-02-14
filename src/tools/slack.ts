import { tool } from "ai";
import { z } from "zod";
import type { WebClient } from "@slack/web-api";
import { logger } from "../lib/logger.js";

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
let userCache: { id: string; displayName: string; realName: string; username: string }[] | null = null;

async function getUserList(
  client: WebClient,
): Promise<{ id: string; displayName: string; realName: string; username: string }[]> {
  if (userCache) return userCache;

  const users: { id: string; displayName: string; realName: string; username: string }[] = [];
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

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve a channel name (with or without #) to a channel ID.
 * Uses cached channel list.
 */
async function resolveChannelByName(
  client: WebClient,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const cleanName = name.replace(/^#/, "").toLowerCase();
  const channels = await getChannelList(client);
  return channels.find((ch) => ch.name.toLowerCase() === cleanName) || null;
}

/**
 * Resolve a user display name / real name to a Slack user ID.
 * Uses cached user list.
 */
async function resolveUserByName(
  client: WebClient,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const cleanName = name.replace(/^@/, "").toLowerCase();
  const users = await getUserList(client);

  const match = users.find(
    (u) =>
      u.displayName.toLowerCase() === cleanName ||
      u.realName.toLowerCase() === cleanName ||
      u.username.toLowerCase() === cleanName,
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

// ── Tool Definitions ─────────────────────────────────────────────────────────

/**
 * Create Slack tools for the AI SDK.
 * Each tool receives the WebClient via closure.
 */
export function createSlackTools(client: WebClient) {
  return {
    list_channels: tool({
      description:
        "List public and private channels in the Slack workspace that Aura has access to. Use this to discover what channels exist before posting or joining.",
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
          // Use full API call here (not cache) to get extra fields like topic, member count
          const result = await client.conversations.list({
            types: "public_channel,private_channel",
            exclude_archived: true,
            limit,
          });

          const channels = (result.channels || []).map((ch) => ({
            name: ch.name || "unknown",
            id: ch.id || "",
            topic: ch.topic?.value || "",
            member_count: ch.num_members || 0,
            is_member: ch.is_member || false,
          }));

          // Populate the channel cache while we're at it
          channelCache = channels.map((ch) => ({ id: ch.id, name: ch.name }));

          logger.info("list_channels tool called", {
            count: channels.length,
          });

          return {
            ok: true,
            channels,
            total: channels.length,
          };
        } catch (error: any) {
          logger.error("list_channels tool failed", { error: error.message });
          return { ok: false, error: `Failed to list channels: ${error.message}` };
        }
      },
    }),

    join_channel: tool({
      description:
        "Join a public Slack channel by name. Aura must join a channel before she can read its history or post messages there. Only works for public channels.",
      inputSchema: z.object({
        channel_name: z
          .string()
          .describe("The name of the channel to join, e.g. 'general' or '#general'"),
      }),
      execute: async ({ channel_name }) => {
        try {
          const channel = await resolveChannelByName(client, channel_name);
          if (!channel) {
            return {
              ok: false,
              error: `Could not find a channel named "${channel_name}". Use list_channels to see available channels.`,
            };
          }

          await client.conversations.join({ channel: channel.id });

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
            channel_name,
            error: error.message,
          });

          if (error.data?.error === "method_not_supported_for_channel_type") {
            return {
              ok: false,
              error: `Cannot join #${channel_name} — it's a private channel. Someone needs to invite me.`,
            };
          }

          return {
            ok: false,
            error: `Failed to join #${channel_name}: ${error.message}`,
          };
        }
      },
    }),

    read_channel_history: tool({
      description:
        "Read recent messages from a Slack channel. Aura must be a member of the channel. Use join_channel first if needed.",
      inputSchema: z.object({
        channel_name: z
          .string()
          .describe("The name of the channel to read, e.g. 'general' or '#general'"),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe("Number of recent messages to fetch (max 50)"),
      }),
      execute: async ({ channel_name, limit }) => {
        try {
          const channel = await resolveChannelByName(client, channel_name);
          if (!channel) {
            return {
              ok: false,
              error: `Could not find a channel named "${channel_name}".`,
            };
          }

          const result = await client.conversations.history({
            channel: channel.id,
            limit,
          });

          // Resolve user IDs to display names
          const messages = await Promise.all(
            (result.messages || []).map(async (msg) => {
              const userName = msg.user
                ? await resolveUserById(client, msg.user)
                : "unknown";
              return {
                user: userName,
                text: msg.text || "",
                timestamp: msg.ts || "",
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
            channel_name,
            error: error.message,
          });

          if (error.data?.error === "not_in_channel") {
            return {
              ok: false,
              error: `I'm not a member of #${channel_name}. Use join_channel to join it first.`,
            };
          }

          return {
            ok: false,
            error: `Failed to read #${channel_name}: ${error.message}`,
          };
        }
      },
    }),

    send_channel_message: tool({
      description:
        "Send a message to a Slack channel. Aura must be a member of the channel. Use join_channel first if needed.",
      inputSchema: z.object({
        channel_name: z
          .string()
          .describe("The name of the channel to post to, e.g. 'general' or '#general'"),
        message: z
          .string()
          .describe("The message text to send. Supports Slack mrkdwn formatting."),
      }),
      execute: async ({ channel_name, message }) => {
        try {
          const channel = await resolveChannelByName(client, channel_name);
          if (!channel) {
            return {
              ok: false,
              error: `Could not find a channel named "${channel_name}".`,
            };
          }

          const result = await client.chat.postMessage({
            channel: channel.id,
            text: message,
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
            channel_name,
            error: error.message,
          });

          if (error.data?.error === "not_in_channel") {
            return {
              ok: false,
              error: `I'm not a member of #${channel_name}. Use join_channel to join it first, then try sending again.`,
            };
          }
          if (error.data?.error === "channel_not_found") {
            return {
              ok: false,
              error: `Channel #${channel_name} not found. Use list_channels to see available channels.`,
            };
          }

          return {
            ok: false,
            error: `Failed to send message to #${channel_name}: ${error.message}`,
          };
        }
      },
    }),

    send_direct_message: tool({
      description:
        "Send a direct message to a user by their display name or username. Opens a DM conversation if one doesn't exist.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, or username of the person to DM, e.g. 'Joan' or '@joan'",
          ),
        message: z
          .string()
          .describe("The message text to send. Supports Slack mrkdwn formatting."),
      }),
      execute: async ({ user_name, message }) => {
        try {
          const user = await resolveUserByName(client, user_name);
          if (!user) {
            return {
              ok: false,
              error: `Could not find a user named "${user_name}". Make sure the name matches their Slack display name, real name, or username.`,
            };
          }

          // Open a DM conversation
          const dmResult = await client.conversations.open({
            users: user.id,
          });

          const dmChannelId = dmResult.channel?.id;
          if (!dmChannelId) {
            return {
              ok: false,
              error: `Failed to open a DM with ${user.name}.`,
            };
          }

          const result = await client.chat.postMessage({
            channel: dmChannelId,
            text: message,
          });

          logger.info("send_direct_message tool called", {
            user: user.name,
            userId: user.id,
            messageTs: result.ts,
          });

          return {
            ok: true,
            message: `Direct message sent to ${user.name}`,
            timestamp: result.ts,
          };
        } catch (error: any) {
          logger.error("send_direct_message tool failed", {
            user_name,
            error: error.message,
          });

          return {
            ok: false,
            error: `Failed to DM ${user_name}: ${error.message}`,
          };
        }
      },
    }),
  };
}
