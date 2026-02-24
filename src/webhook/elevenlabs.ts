import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { waitUntil } from "@vercel/functions";
import crypto from "node:crypto";
import { logger } from "../lib/logger.js";
import { recordError } from "../lib/metrics.js";
import { safePostMessage } from "../lib/slack-messaging.js";
import { db } from "../db/client.js";
import { voiceCalls, notes } from "../db/schema.js";
import { getUserList } from "../tools/slack.js";

// ── Config ──────────────────────────────────────────────────────────────────

const botToken = process.env.SLACK_BOT_TOKEN || "";
const webhookSecret = process.env.ELEVENLABS_WEBHOOK_SECRET || "";

const VOICE_TESTING_CHANNEL = process.env.ELEVENLABS_VOICE_CHANNEL || "";

const slackClient = new WebClient(botToken);

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

// ── Signature Verification ──────────────────────────────────────────────────

function verifyElevenLabsSignature(
  rawBody: string,
  signatureHeader: string,
): boolean {
  if (!webhookSecret) {
    logger.warn(
      "ELEVENLABS_WEBHOOK_SECRET not configured — rejecting request",
    );
    return false;
  }

  if (!signatureHeader) return false;

  // ElevenLabs-Signature header format: t=<timestamp>,v1=<signature>
  const parts: Record<string, string> = {};
  for (const part of signatureHeader.split(",")) {
    const [key, ...rest] = part.split("=");
    if (key && rest.length) {
      parts[key.trim()] = rest.join("=").trim();
    }
  }

  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  if (parseInt(timestamp) < fiveMinutesAgo) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(signedPayload, "utf8")
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(signature, "utf8"),
    );
  } catch {
    return false;
  }
}

// ── Inbound/Outbound Detection ──────────────────────────────────────────────

function isOutboundCall(metadata: any): boolean {
  const dynVars = metadata?.dynamic_variables || metadata?.dynamicVariables || {};
  return dynVars.direction === "outbound";
}

// ── Tool Handlers ───────────────────────────────────────────────────────────

async function handleLookupContext(
  params: { person_name: string } | undefined,
  outbound: boolean,
): Promise<string> {
  try {
    const { person_name } = params ?? { person_name: "" };
    if (!person_name) return "Missing required parameter: person_name";

    if (!outbound) {
      return `User asked about "${person_name}". I can confirm their name but cannot share internal details for inbound calls.`;
    }

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
  } catch (err) {
    const name = params?.person_name ?? "unknown";
    logger.error("lookup_context failed", {
      person_name: name,
      error: err instanceof Error ? err.message : String(err),
    });
    return `Error looking up "${name}": ${err instanceof Error ? err.message : "unknown error"}`;
  }
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
elevenlabsWebhookApp.post("/tool", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("elevenlabs-signature") || "";

  if (!verifyElevenLabsSignature(rawBody, signature)) {
    logger.warn("Invalid ElevenLabs webhook signature on /tool");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let body: {
    tool_call_id?: string;
    tool_name?: string;
    parameters?: Record<string, unknown>;
    dynamic_variables?: Record<string, unknown>;
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const { tool_call_id, tool_name, parameters, dynamic_variables } = body;
  const outbound = isOutboundCall({ dynamic_variables });

  logger.info("ElevenLabs server tool called", {
    tool_call_id,
    tool_name,
    direction: outbound ? "outbound" : "inbound",
  });

  let result: string;

  switch (tool_name) {
    case "lookup_context":
      result = await handleLookupContext(
        parameters as { person_name: string } | undefined,
        outbound,
      );
      break;

    case "post_to_slack":
      result = await handlePostToSlack(
        parameters as { channel: string; message: string } | undefined,
      );
      break;

    default:
      logger.warn("Unknown ElevenLabs tool", { tool_name });
      result = `Unknown tool: ${tool_name}`;
  }

  return c.json({ result });
});

// Post-call webhook — called by ElevenLabs after every call ends
elevenlabsWebhookApp.post("/post-call", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("elevenlabs-signature") || "";

  if (!verifyElevenLabsSignature(rawBody, signature)) {
    logger.warn("Invalid ElevenLabs webhook signature on /post-call");
    return c.json({ error: "Invalid signature" }, 401);
  }

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
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
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
