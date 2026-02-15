import { tool } from "ai";
import { z } from "zod";
import type { WebClient } from "@slack/web-api";
import { logger } from "../lib/logger.js";
import { createNoteTools } from "./notes.js";
import { createScheduleTools, type ScheduleContext } from "./schedule.js";

// ── Rate Limiter ─────────────────────────────────────────────────────────────

/**
 * Simple token-bucket rate limiter for Slack API calls.
 * Slack's Tier 2/3 methods allow ~20-50 requests per minute.
 * We limit to 15 req/min with a burst of 5 to stay well under.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 15;
const requestTimestamps: number[] = [];

async function throttle(): Promise<void> {
  const now = Date.now();

  // Prune timestamps outside the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    // Wait until the oldest request falls outside the window
    const waitMs = requestTimestamps[0] + RATE_LIMIT_WINDOW_MS - now + 50;
    logger.info(`Slack API throttle: waiting ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  requestTimestamps.push(Date.now());
}

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
    await throttle();
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
    await throttle();
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
 * Resolve a channel name or ID to a channel object.
 * Accepts: "general", "#general", "C0BNVKS77", "#dev (C0BNVKS77)"
 */
async function resolveChannelByName(
  client: WebClient,
  name: string,
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

  // Name-based lookup via cache
  const channels = await getChannelList(client);
  return channels.find((ch) => ch.name.toLowerCase() === cleaned.toLowerCase()) || null;
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
    await throttle();
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
          await throttle();
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

          await throttle();
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

          await throttle();
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

          await throttle();
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
          .describe("The display name, real name, or username of the person to look up"),
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

          await throttle();
          const result = await client.users.info({ user: user.id });
          const u = result.user;

          if (!u) {
            return { ok: false, error: `Failed to fetch profile for ${user_name}.` };
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
          return { ok: false, error: `Failed to search users: ${error.message}` };
        }
      },
    }),

    search_messages: tool({
      description:
        "Search for messages across the entire Slack workspace. Supports Slack's search syntax: use 'in:#channel' to filter by channel, 'from:@user' to filter by sender. Requires SLACK_USER_TOKEN to be configured.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Search query. Supports Slack search syntax like 'budget in:#finance from:@joan'"),
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

          await throttle();
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
          await throttle();
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

          await throttle();
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
          await throttle();
          const result = await (client as any).apiCall("slackLists.items.list", {
            list_id,
            limit,
          });

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

          return {
            ok: true,
            list_id,
            items: result.items || [],
            count: result.items?.length || 0,
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
        list_id: z
          .string()
          .describe("The ID of the Slack List"),
        item_id: z
          .string()
          .describe("The ID of the specific item/record to retrieve"),
      }),
      execute: async ({ list_id, item_id }) => {
        try {
          await throttle();
          const result = await (client as any).apiCall("slackLists.items.info", {
            list_id,
            item_id,
          });

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

          return {
            ok: true,
            item: result.item || null,
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
        canvas_id: z
          .string()
          .describe("The ID of the Canvas to read"),
      }),
      execute: async ({ canvas_id }) => {
        try {
          await throttle();
          const result = await (client as any).apiCall("canvases.sections.lookup", {
            canvas_id,
          });

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
        title: z
          .string()
          .describe("Title for the new canvas"),
        content: z
          .string()
          .describe("Markdown content for the canvas body"),
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

          await throttle();
          const result = await (client as any).apiCall("canvases.create", params);

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
        canvas_id: z
          .string()
          .describe("The ID of the Canvas to edit"),
        operation: z
          .enum(["insert_at_end", "insert_at_start", "replace", "rename"])
          .describe("The type of edit operation to perform"),
        content: z
          .string()
          .describe("Markdown content to insert/replace, or the new title for rename"),
        section_id: z
          .string()
          .optional()
          .describe("Section ID to replace (required for 'replace' operation). Use read_canvas to find section IDs."),
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
                error: "Section ID is required for replace operations. Use read_canvas to find section IDs.",
              };
            }
            changes = [{
              operation: "replace",
              section_id,
              document_content: { type: "markdown", markdown: content },
            }];
          } else {
            // insert_at_start or insert_at_end
            changes = [{
              operation,
              document_content: { type: "markdown", markdown: content },
            }];
          }

          await throttle();
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

    // ── Note / Scratchpad Tools ────────────────────────────────────────────
    ...createNoteTools(),

    // ── Scheduling Tools ─────────────────────────────────────────────────
    ...createScheduleTools(client, context),
  };
}
