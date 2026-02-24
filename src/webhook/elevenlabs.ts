import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { waitUntil } from "@vercel/functions";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { recordError } from "../lib/metrics.js";
import { safePostMessage } from "../lib/slack-messaging.js";
import { db } from "../db/client.js";
import { voiceCalls, notes } from "../db/schema.js";
import { getUserList } from "../tools/slack.js";
import { embedText } from "../lib/embeddings.js";
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
): Promise<{ context?: string; person?: { name: string } }> {
  const { person_name, query } = params;

  if (!person_name && !query) {
    return { context: "Provide person_name or query to look up context." };
  }

  const result: { context?: string; person?: { name: string } } = {};
  const contextParts: string[] = [];

  if (person_name) {
    const users = await getCachedUserList(slackClient);
    const nameLower = person_name.toLowerCase();
    const match = users.find((u) => {
      const name = (u.displayName || u.realName || u.username || "").toLowerCase();
      return name.includes(nameLower);
    });

    if (match) {
      const displayName = match.displayName || match.realName || match.username || "Unknown";
      result.person = { name: displayName };
    }

    if (!query) {
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
          contextParts.push(
            relatedNotes
              .map((n, i) => `${i + 1}. ${n.topic}: ${n.content.slice(0, 500)}`)
              .join("\n"),
          );
        }
      } catch {
        // Name-based note lookup is non-critical
      }
    }
  }

  if (query) {
    try {
      const queryEmbedding = await embedText(query);
      const embeddingLiteral = JSON.stringify(queryEmbedding);

      const noteResults = await db
        .select({
          topic: notes.topic,
          content: notes.content,
        })
        .from(notes)
        .where(sql`${notes.embedding} IS NOT NULL`)
        .orderBy(sql`${notes.embedding} <=> ${embeddingLiteral}::vector`)
        .limit(5);

      if (noteResults.length > 0) {
        const formatted = noteResults
          .map((n, i) => `${i + 1}. ${n.topic}: ${n.content.slice(0, 500)}`)
          .join("\n");
        contextParts.push(`Found ${noteResults.length} relevant notes:\n${formatted}`);
      } else {
        contextParts.push(`No notes found matching "${query}".`);
      }
    } catch (err) {
      logger.error("Semantic note search failed", {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
      contextParts.push(`Note search failed for "${query}".`);
    }
  }

  if (contextParts.length > 0) {
    result.context = contextParts.join("\n\n");
  }

  if (!result.context && !result.person) {
    result.context = person_name
      ? `No information found for "${person_name}".`
      : `No results found for query "${query}".`;
  }

  return result;
}

async function handlePostToSlack(
  params: { channel: string; message: string } | undefined,
): Promise<string> {
  try {
    const { channel, message } = params ?? { channel: "", message: "" };
    if (!channel || !message) return "Missing required parameters: channel, message";

    const allowedChannels = VOICE_TESTING_CHANNEL ? [VOICE_TESTING_CHANNEL] : [];
    if (!allowedChannels.includes(channel)) {
      logger.warn("post_to_slack blocked: channel not in allowlist", { channel });
      return `Channel "${channel}" is not in the allowed channels list`;
    }

    await safePostMessage(slackClient, {
      channel,
      text: message,
    });
    return "Message posted successfully";
  } catch (err) {
    logger.error("post_to_slack failed", {
      channel: params?.channel,
      error: err instanceof Error ? err.message : String(err),
    });
    return `Error posting to channel: ${err instanceof Error ? err.message : "unknown error"}`;
  }
}

// ── Hono Sub-App ────────────────────────────────────────────────────────────

export const elevenlabsWebhookApp = new Hono();

// Server tool endpoint — called by ElevenLabs during a voice conversation
// NOTE: Server tool calls use a shared secret header (x-webhook-secret),
// NOT the HMAC-signed elevenlabs-signature used by post-call webhooks.
// The secret is stored as a Workspace Secret in ElevenLabs and referenced
// by ID in the tool's request_headers config.
elevenlabsWebhookApp.post("/tool", async (c) => {
  const rawBody = await c.req.text();
  const headerSecret = c.req.header("x-webhook-secret") || "";

  if (!webhookSecret || headerSecret !== webhookSecret) {
    logger.warn("Invalid or missing x-webhook-secret on /tool", {
      hasSecret: !!headerSecret,
      hasExpected: !!webhookSecret,
    });
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: { person_name?: string; query?: string };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const { person_name, query } = body;

  logger.info("ElevenLabs lookup_context tool called", {
    person_name,
    query,
  });

  try {
    const result = await handleLookupContext({ person_name, query });
    return c.json(result);
  } catch (err) {
    logger.error("lookup_context failed", {
      person_name,
      query,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ context: "Error looking up context." }, 500);
  }
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
