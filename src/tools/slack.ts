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
import type { ScheduleContext } from "../db/schema.js";

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

async function getUserList(
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

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Search for a public channel by name using the user token.
 * The bot token's conversations.list only returns channels the bot is in,
 * so we need the user token to find channels the bot hasn't joined yet.
 */
async function searchPublicChannelByName(
  name: string,
): Promise<{ id: string; name: string } | null> {
  const userToken = process.env.SLACK_USER_TOKEN;
  if (!userToken) return null;

  try {
    const { WebClient } = await import("@slack/web-api");
    const userClient = new WebClient(userToken);
    const cleanLower = name.toLowerCase();

    let cursor: string | undefined;
    do {
      const result = await userClient.conversations.list({
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
    logger.warn("searchPublicChannelByName fallback failed", {
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
async function resolveChannelByName(
  client: WebClient,
  name: string,
  options?: { fallbackToUserToken?: boolean },
): Promise<{ id: string; name: string } | null> {
  const cleaned = name.replace(/^#/, "").trim();

  // Extract parenthetical ID if present: "dev (C0BNVKS77)" -> use ID
  const idInParens = cleaned.match(/\(?(C[A-Z0-9]+)\)?/);
  if (idInParens) {
    const id = idInParens[1];
    const displayName = cleaned.replace(/\s*\(?C[A-Z0-9]+\)?/, "").trim();
    return { id, name: displayName || id };
  }

  // If it looks like a raw channel ID
  if (/^C[A-Z0-9]+$/.test(cleaned)) {
    return { id: cleaned, name: cleaned };
  }

  // Name-based lookup via bot's cache (channels bot is already in)
  const channels = await getChannelList(client);
  const match = channels.find(
    (ch) => ch.name.toLowerCase() === cleaned.toLowerCase(),
  );
  if (match) return match;

  // Fallback: search all public channels via user token
  if (options?.fallbackToUserToken) {
    const fallbackMatch = await searchPublicChannelByName(cleaned);
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
async function resolveUserByName(
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
          // Try user token first — it can see ALL public channels, not just ones the bot is in
          const userToken = process.env.SLACK_USER_TOKEN;
          let allChannels: Array<{
            name: string;
            id: string;
            topic: string;
            member_count: number;
            is_member: boolean;
          }> = [];

          if (userToken) {
            try {
              const { WebClient } = await import("@slack/web-api");
              const userClient = new WebClient(userToken);

              let cursor: string | undefined;
              const collected: typeof allChannels = [];
              do {
                const result = await userClient.conversations.list({
                  types: "public_channel",
                  exclude_archived: true,
                  limit: 200,
                  cursor,
                });

                for (const ch of result.channels || []) {
                  collected.push({
                    name: ch.name || "unknown",
                    id: ch.id || "",
                    topic: ch.topic?.value || "",
                    member_count: ch.num_members || 0,
                    is_member: ch.is_member || false,
                  });
                }

                cursor = result.response_metadata?.next_cursor || undefined;
              } while (cursor && collected.length < limit);

              allChannels = collected.slice(0, limit);

              // Fetch ALL bot's channels (paginated) to get accurate is_member
              // (user token's is_member reflects the user, not the bot)
              // and to discover private channels the bot is in
              const botMemberIds = new Set<string>();
              const botPrivateChannels: typeof allChannels = [];
              let botCursor: string | undefined;
              do {
                const botResult = await client.conversations.list({
                  types: "public_channel,private_channel",
                  exclude_archived: true,
                  limit: 200,
                  cursor: botCursor,
                });

                for (const ch of botResult.channels || []) {
                  if (ch.is_member && ch.id) {
                    botMemberIds.add(ch.id);
                  }
                  if (
                    ch.is_private &&
                    !allChannels.find((existing) => existing.id === ch.id)
                  ) {
                    botPrivateChannels.push({
                      name: ch.name || "unknown",
                      id: ch.id || "",
                      topic: ch.topic?.value || "",
                      member_count: ch.num_members || 0,
                      is_member: ch.is_member || false,
                    });
                  }
                }

                botCursor =
                  botResult.response_metadata?.next_cursor || undefined;
              } while (botCursor);

              // Fix is_member on public channels to reflect the bot's membership
              for (const ch of allChannels) {
                ch.is_member = botMemberIds.has(ch.id);
              }

              // Add private channels from bot that aren't already listed
              for (const ch of botPrivateChannels) {
                allChannels.push(ch);
              }

              // Enforce the limit after merging public + private channels
              allChannels = allChannels.slice(0, limit);
            } catch (userTokenError: any) {
              logger.warn(
                "list_channels user token path failed, falling back to bot-only",
                {
                  error: userTokenError.message,
                },
              );
              // Fall through to bot-only listing below
              allChannels = [];
            }
          }

          if (allChannels.length === 0) {
            // No user token, or user token failed — fall back to bot-only listing
            const result = await client.conversations.list({
              types: "public_channel,private_channel",
              exclude_archived: true,
              limit,
            });

            allChannels = (result.channels || []).map((ch) => ({
              name: ch.name || "unknown",
              id: ch.id || "",
              topic: ch.topic?.value || "",
              member_count: ch.num_members || 0,
              is_member: ch.is_member || false,
            }));
          }

          logger.info("list_channels tool called", {
            count: allChannels.length,
          });

          return {
            ok: true,
            channels: allChannels,
            total: allChannels.length,
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
          const messages = await Promise.all(
            (result.messages || []).map(async (msg) => {
              const userName = msg.user
                ? await resolveUserById(client, msg.user)
                : "unknown";
              return {
                user: userName,
                text: msg.text || "",
                timestamp: msg.ts || "",
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
      }),
      execute: async ({ query }) => {
        try {
          const allUsers = await getUserList(client);
          const q = query.toLowerCase();

          const matches = allUsers.filter(
            (u) =>
              u.displayName.toLowerCase().includes(q) ||
              u.realName.toLowerCase().includes(q) ||
              u.username.toLowerCase().includes(q),
          );

          const results = matches.map((u) => ({
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
        const userToken = process.env.SLACK_USER_TOKEN;
        if (!userToken) {
          return {
            ok: false,
            error:
              "Message search requires a SLACK_USER_TOKEN environment variable (a user OAuth token with search:read scope). It's not currently configured.",
          };
        }

        try {
          // Use a separate client with the user token for search
          const { WebClient } = await import("@slack/web-api");
          const searchClient = new WebClient(userToken);

          const result = await searchClient.search.messages({
            query,
            count,
            sort: "timestamp",
            sort_dir: "desc",
          });

          const matches = (result.messages?.matches || []).map((m: any) => ({
            user: m.username || m.user || "unknown",
            text: m.text || "",
            channel: m.channel?.name || "unknown",
            timestamp: m.ts || "",
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
        "Send a direct message to a user by their display name or username. Opens a DM conversation if one doesn't exist.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, or username of the person to DM, e.g. 'Joan' or '@joan'",
          ),
        message: z
          .string()
          .describe(
            "The message text to send. Supports Slack mrkdwn formatting.",
          ),
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

    read_dm_history: tool({
      description:
        "Read recent messages from a direct message conversation with a specific user. Use this to check past DM conversations, follow up on earlier messages, or recall what was discussed in a DM.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, username, or user ID of the person whose DM history to read, e.g. 'Joan' or '@joan' or 'U066V1AN6'",
          ),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe("Number of recent messages to fetch (max 50)"),
      }),
      execute: async ({ user_name, limit }) => {
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

          // Fetch conversation history
          const result = await client.conversations.history({
            channel: dmChannelId,
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

          logger.info("read_dm_history tool called", {
            user: user.name,
            userId: user.id,
            dmChannelId,
            messageCount: messages.length,
          });

          return {
            ok: true,
            user: user.name,
            user_id: user.id,
            dm_channel_id: dmChannelId,
            messages,
            count: messages.length,
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
        "List DM conversations Aura has had. Returns the list of users Aura has open DM channels with. Use this to see who you've been talking to, find conversations to follow up on, or enumerate your DM activity. Admin-only.",
      inputSchema: z.object({
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(20)
          .describe("Maximum number of DM conversations to return (max 100)"),
      }),
      execute: async ({ limit }) => {
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

          const conversations: Array<{
            user_name: string;
            user_id: string;
            dm_channel_id: string;
            last_message_preview: string;
            last_activity_ts: string;
          }> = [];

          let cursor: string | undefined;
          let fetched = 0;

          do {
            const result = await client.conversations.list({
              types: "im",
              exclude_archived: true,
              limit: Math.min(200, limit - fetched),
              cursor,
            });

            for (const ch of result.channels || []) {
              if (!ch.id || !ch.user) continue;

              const userName = userNameMap.get(ch.user) || ch.user;
              const updated = (ch as any).updated;
              conversations.push({
                user_name: userName,
                user_id: ch.user,
                dm_channel_id: ch.id,
                last_message_preview: "",
                last_activity_ts:
                  typeof updated === "number" && updated > 0
                    ? String(updated)
                    : "",
              });

              fetched++;
              if (fetched >= limit) break;
            }

            cursor = result.response_metadata?.next_cursor || undefined;
          } while (cursor && fetched < limit);

          logger.info("list_dm_conversations tool called", {
            count: conversations.length,
          });

          return {
            ok: true,
            conversations,
            count: conversations.length,
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
      }),
      execute: async ({ list_id, limit }) => {
        try {
          const result = await (client as any).apiCall(
            "slackLists.items.list",
            {
              list_id,
              limit,
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
        "Edit an existing Slack Canvas. Supports inserting content at the start or end, replacing a section, or renaming the canvas.",
      inputSchema: z.object({
        canvas_id: z.string().describe("The ID of the Canvas to edit"),
        operation: z
          .enum(["insert_at_end", "insert_at_start", "replace", "rename"])
          .describe("The type of edit operation to perform"),
        content: z
          .string()
          .describe(
            "Markdown content to insert/replace, or the new title for rename",
          ),
        section_id: z
          .string()
          .optional()
          .describe(
            "Section ID to replace (required for 'replace' operation). Use read_canvas to find section IDs.",
          ),
      }),
      execute: async ({ canvas_id, operation, content, section_id }) => {
        try {
          let changes: any[];

          if (operation === "rename") {
            changes = [{ operation: "rename", title: content }];
          } else if (operation === "replace") {
            if (!section_id) {
              return {
                ok: false,
                error:
                  "Section ID is required for replace operations. Use read_canvas to find section IDs.",
              };
            }
            changes = [
              {
                operation: "replace",
                section_id,
                document_content: { type: "markdown", markdown: content },
              },
            ];
          } else {
            // insert_at_start or insert_at_end
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
            text: new_text,
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
            text: message,
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
    ...createBigQueryTools(),
  };
}
