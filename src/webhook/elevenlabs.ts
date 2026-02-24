import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { waitUntil } from "@vercel/functions";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { recordError } from "../lib/metrics.js";
import { safePostMessage } from "../lib/slack-messaging.js";
import { formatForSlack } from "../lib/format.js";
import { embedText } from "../lib/embeddings.js";
import { db } from "../db/client.js";
import { voiceCalls, notes } from "../db/schema.js";
import { getUserList, resolveUserByName } from "../tools/slack.js";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

// ── Config ──────────────────────────────────────────────────────────────────

const botToken = process.env.SLACK_BOT_TOKEN || "";
const webhookSecret = process.env.ELEVENLABS_WEBHOOK_SECRET || "";

const VOICE_TESTING_CHANNEL = process.env.ELEVENLABS_VOICE_CHANNEL || "";

const slackClient = new WebClient(botToken);
const elevenlabs = new ElevenLabsClient();

// ── Cached User List ─────────────────────────────────────────────────────────

let cachedUsers: Awaited<ReturnType<typeof getUserList>> | null = null;
let cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 min

async function getCachedUserList(client: WebClient) {
  if (!cachedUsers || Date.now() - cacheTime > CACHE_TTL) {
    cachedUsers = await getUserList(client);
    cacheTime = Date.now();
  }
  return cachedUsers;
}

// ── Inbound/Outbound Detection ──────────────────────────────────────────────

function isOutboundCall(metadata: any): boolean {
  const dynVars = metadata?.dynamic_variables || metadata?.dynamicVariables || {};
  return dynVars.direction === "outbound";
}

// ── Tool Handlers ───────────────────────────────────────────────────────────

async function handleLookupContext(
  params: { person_name?: string; query?: string },
): Promise<string> {
  try {
    const { person_name, query } = params;

    if (query) {
      const vector = await embedText(query);
      const results = await db
        .select({ topic: notes.topic, content: notes.content })
        .from(notes)
        .where(sql`embedding IS NOT NULL`)
        .orderBy(sql`embedding <=> ${JSON.stringify(vector)}::vector`)
        .limit(5);

      if (results.length === 0) {
        return `No relevant context found for "${query}".`;
      }

      let context = `Context for "${query}":\n`;
      for (const note of results) {
        context += `\n- ${note.topic}: ${note.content.slice(0, 300)}`;
      }
      return context;
    }

    if (person_name) {
      const users = await getCachedUserList(slackClient);
      const nameLower = person_name.toLowerCase();
      const match = users.find((u) => {
        const name = (u.displayName || u.realName || u.username || "").toLowerCase();
        return name.includes(nameLower);
      });

      if (!match) {
        return `No Slack user found matching "${person_name}".`;
      }

      const displayName = match.displayName || match.realName || match.username || "Unknown";
      let context = `*${displayName}* (Slack ID: ${match.id})`;

      try {
        const { ilike } = await import("drizzle-orm");
        const escapedName = person_name
          .replace(/%/g, "\\%")
          .replace(/_/g, "\\_");
        const relatedNotes = await db
          .select({ topic: notes.topic, content: notes.content })
          .from(notes)
          .where(ilike(notes.topic, `%${escapedName}%`))
          .limit(3);

        if (relatedNotes.length > 0) {
          context += "\n\nRelated notes:";
          for (const note of relatedNotes) {
            context += `\n- ${note.topic}: ${note.content.slice(0, 200)}`;
          }
        }
      } catch {
        // Notes lookup is non-critical
      }

      return context;
    }

    return "Missing required parameter: provide either 'query' or 'person_name'.";
  } catch (err) {
    logger.error("lookup_context failed", {
      person_name: params.person_name,
      query: params.query,
      error: err instanceof Error ? err.message : String(err),
    });
    return `Error in lookup_context: ${err instanceof Error ? err.message : "unknown error"}`;
  }
}

async function handleSendDm(
  params: { user_name?: string; message?: string },
): Promise<string> {
  try {
    const { user_name, message } = params;
    if (!user_name || !message) return "Missing required parameters: user_name, message";

    const user = await resolveUserByName(slackClient, user_name);
    if (!user) {
      return `Could not find a Slack user matching "${user_name}".`;
    }

    const dm = await slackClient.conversations.open({ users: user.id });
    if (!dm.channel?.id) {
      return `Failed to open DM conversation with ${user.name}.`;
    }

    await safePostMessage(slackClient, {
      channel: dm.channel.id,
      text: formatForSlack(message),
    });

    return `Message sent to ${user.name} successfully.`;
  } catch (err) {
    logger.error("send_dm failed", {
      user_name: params.user_name,
      error: err instanceof Error ? err.message : String(err),
    });
    return `Error sending DM: ${err instanceof Error ? err.message : "unknown error"}`;
  }
}

// ── Hono Sub-App ────────────────────────────────────────────────────────────

export const elevenlabsWebhookApp = new Hono();

// Server tool endpoint — called by ElevenLabs during a voice conversation.
// Each tool has its own route: /tool/lookup_context, /tool/send_dm, etc.
// ElevenLabs sends parameters flat in the request body (no tool_name wrapper).
// Auth: shared secret via x-webhook-secret header, stored as a Workspace
// Secret in ElevenLabs and referenced by ID in the tool's request_headers.
elevenlabsWebhookApp.post("/tool/:toolName", async (c) => {
  const headerSecret = c.req.header("x-webhook-secret") || "";

  if (!webhookSecret || headerSecret !== webhookSecret) {
    logger.warn("Invalid or missing x-webhook-secret on /tool/:toolName", {
      hasSecret: !!headerSecret,
      hasExpected: !!webhookSecret,
    });
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const toolName = c.req.param("toolName");

  logger.info("ElevenLabs server tool called", { toolName, bodyKeys: Object.keys(body) });

  let result: string;

  switch (toolName) {
    case "lookup_context":
      result = await handleLookupContext(
        body as { person_name?: string; query?: string },
      );
      break;

    case "send_dm":
      result = await handleSendDm(
        body as { user_name?: string; message?: string },
      );
      break;

    default:
      logger.warn("Unknown ElevenLabs tool", { toolName });
      result = `Unknown tool: ${toolName}`;
  }

  return c.json({ result });
});

// Post-call webhook — called by ElevenLabs after every call ends
elevenlabsWebhookApp.post("/post-call", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("elevenlabs-signature") || "";

  let body: {
    type?: string;
    data?: {
      agent_id?: string;
      conversation_id?: string;
      status?: string;
      transcript?: unknown;
      analysis?: { summary?: string; data_points?: Record<string, unknown> };
      metadata?: {
        call_duration_secs?: number;
        phone_number?: string;
        dynamic_variables?: Record<string, unknown>;
      };
    };
  };
  try {
    body = await elevenlabs.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    logger.warn("Invalid ElevenLabs webhook signature on /post-call", {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Invalid signature" }, 401);
  }

  const data = body.data ?? {};

  logger.info("ElevenLabs post-call webhook received", {
    type: body.type,
    agent_id: data.agent_id,
    conversation_id: data.conversation_id,
    status: data.status,
    duration: data.metadata?.call_duration_secs,
  });

  const processPostCall = async () => {
    try {
      const duration = data.metadata?.call_duration_secs;
      const summary = data.analysis?.summary || "No summary available";
      const transcript = data.transcript;
      const conversationId = data.conversation_id || crypto.randomUUID();
      const agentId = data.agent_id;
      const phoneNumber = data.metadata?.phone_number;
      const dynVars = data.metadata?.dynamic_variables;
      const outbound = isOutboundCall(data.metadata);
      const direction = outbound ? "outbound" : "inbound";
      const personName = dynVars?.person_name as string | undefined;
      const callContext = dynVars?.call_context as string | undefined;

      const transcriptText =
        typeof transcript === "string"
          ? transcript
          : transcript != null
            ? JSON.stringify(transcript)
            : "";

      const durationStr =
        duration != null
          ? `${Math.floor(duration / 60)}m ${duration % 60}s`
          : "unknown duration";

      // Store in voice_calls table
      const callStatus =
        data.status === "error" || data.status === "failed"
          ? "failed"
          : "completed";

      const { transcript: _t, analysis: _a, ...metadataRest } = data;
      const strippedMetadata = metadataRest as Record<string, unknown>;

      await db
        .insert(voiceCalls)
        .values({
          conversationId,
          agentId: agentId ?? null,
          direction,
          phoneNumber: phoneNumber ?? null,
          personName: personName ?? null,
          status: callStatus,
          durationSeconds: duration ?? null,
          transcript: transcript ?? null,
          summary,
          callContext: callContext ?? null,
          dynamicVariables: dynVars ?? null,
          metadata: strippedMetadata,
        })
        .onConflictDoUpdate({
          target: voiceCalls.conversationId,
          set: {
            status: callStatus,
            durationSeconds: duration ?? null,
            transcript: transcript ?? null,
            summary,
            metadata: strippedMetadata,
            updatedAt: new Date(),
          },
        });

      logger.info("Voice call stored", { conversationId, direction, callStatus });

      // Post summary to #voice-testing channel
      const directionEmoji = outbound ? ":telephone_receiver:" : ":phone:";
      const directionLabel = outbound ? "Outbound" : "Inbound";
      const callerInfo = personName
        ? `*${directionLabel} — ${personName}*`
        : phoneNumber
          ? `*${directionLabel} — ${phoneNumber}*`
          : `*${directionLabel} call*`;

      const truncatedTranscript =
        transcriptText.length > 500
          ? transcriptText.slice(0, 500) + "..."
          : transcriptText;

      const slackMessage =
        `${directionEmoji} *Voice call ended*\n` +
        `${callerInfo}\n` +
        `*Duration:* ${durationStr}\n` +
        `*Status:* ${callStatus}\n` +
        `*Conversation ID:* \`${conversationId}\`\n` +
        `*Summary:* ${summary}` +
        (truncatedTranscript
          ? `\n\n*Transcript excerpt:*\n>${truncatedTranscript}`
          : "");

      try {
        if (VOICE_TESTING_CHANNEL) {
          await safePostMessage(slackClient, {
            channel: VOICE_TESTING_CHANNEL,
            text: slackMessage,
          });
          logger.info("Post-call summary sent to voice channel", { conversationId });
        } else {
          logger.warn("ELEVENLABS_VOICE_CHANNEL not configured — skipping post-call message");
        }
      } catch (slackErr) {
        logger.error("Failed to post call summary to Slack", {
          conversationId,
          error: slackErr instanceof Error ? slackErr.message : String(slackErr),
        });
      }
    } catch (err) {
      recordError("elevenlabs_post_call", err, {
        conversation_id: data.conversation_id,
      });
    }
  };

  waitUntil(processPostCall());
  return c.json({ ok: true });
});
