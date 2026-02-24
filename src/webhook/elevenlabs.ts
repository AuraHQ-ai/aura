import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { waitUntil } from "@vercel/functions";
import crypto from "node:crypto";
import { logger } from "../lib/logger.js";
import { recordError } from "../lib/metrics.js";
import { safePostMessage } from "../lib/slack-messaging.js";
import { db } from "../db/client.js";
import { notes } from "../db/schema.js";
import { getUserList } from "../tools/slack.js";

// ── Config ──────────────────────────────────────────────────────────────────

const botToken = process.env.SLACK_BOT_TOKEN || "";
const webhookSecret = process.env.ELEVENLABS_WEBHOOK_SECRET || "";
const JOAN_USER_ID = "U0678NQJ2";

const slackClient = new WebClient(botToken);

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

// ── Tool Handlers ───────────────────────────────────────────────────────────

async function handleLookupContext(
  params: { person_name: string },
): Promise<string> {
  const { person_name } = params;

  try {
    const users = await getUserList(slackClient);
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

    // Look up any stored notes about this person
    try {
      const { like } = await import("drizzle-orm");
      const escapedName = person_name
        .toLowerCase()
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_");
      const relatedNotes = await db
        .select({ topic: notes.topic, content: notes.content })
        .from(notes)
        .where(like(notes.topic, `%${escapedName}%`))
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
    logger.error("lookup_context failed", {
      person_name,
      error: err instanceof Error ? err.message : String(err),
    });
    return `Error looking up "${person_name}": ${err instanceof Error ? err.message : "unknown error"}`;
  }
}

async function handlePostToSlack(
  params: { channel: string; message: string },
): Promise<string> {
  const { channel, message } = params;

  try {
    await safePostMessage(slackClient, {
      channel,
      text: message,
    });
    return "Message posted successfully";
  } catch (err) {
    logger.error("post_to_slack failed", {
      channel,
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
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const { tool_call_id, tool_name, parameters } = body;

  logger.info("ElevenLabs server tool called", { tool_call_id, tool_name });

  let result: string;

  switch (tool_name) {
    case "lookup_context":
      result = await handleLookupContext(
        parameters as { person_name: string },
      );
      break;

    case "post_to_slack":
      result = await handlePostToSlack(
        parameters as { channel: string; message: string },
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
    agent_id?: string;
    conversation_id?: string;
    status?: string;
    transcript?: string;
    analysis?: { summary?: string; data_points?: Record<string, unknown> };
    metadata?: { call_duration_secs?: number };
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  logger.info("ElevenLabs post-call webhook received", {
    agent_id: body.agent_id,
    conversation_id: body.conversation_id,
    status: body.status,
    duration: body.metadata?.call_duration_secs,
  });

  const processPostCall = async () => {
    try {
      const duration = body.metadata?.call_duration_secs;
      const summary = body.analysis?.summary || "No summary available";
      const transcript = body.transcript || "";
      const conversationId = body.conversation_id || "unknown";

      // Extract caller info from transcript if available
      const durationStr =
        duration != null
          ? `${Math.floor(duration / 60)}m ${duration % 60}s`
          : "unknown duration";

      const slackMessage =
        `:telephone_receiver: *Voice call ended*\n` +
        `*Duration:* ${durationStr}\n` +
        `*Conversation ID:* \`${conversationId}\`\n` +
        `*Summary:* ${summary}` +
        (transcript
          ? `\n\n*Transcript excerpt:*\n>${transcript.slice(0, 500)}${transcript.length > 500 ? "..." : ""}`
          : "");

      // DM Joan with the call summary
      const dmResult = await slackClient.conversations.open({
        users: JOAN_USER_ID,
      });
      const dmChannelId = dmResult.channel?.id;

      if (dmChannelId) {
        await safePostMessage(slackClient, {
          channel: dmChannelId,
          text: slackMessage,
        });
        logger.info("Post-call summary sent to Joan", { conversationId });
      }

      // Store call log as a note
      const noteContent =
        `**Call Duration:** ${durationStr}\n` +
        `**Status:** ${body.status || "unknown"}\n` +
        `**Summary:** ${summary}\n` +
        `**Transcript:** ${transcript.slice(0, 2000)}`;

      await db
        .insert(notes)
        .values({
          topic: `elevenlabs-call:${conversationId}`,
          content: noteContent,
          category: "knowledge",
        })
        .onConflictDoUpdate({
          target: notes.topic,
          set: {
            content: noteContent,
            updatedAt: new Date(),
          },
        });

      logger.info("Post-call note stored", { conversationId });
    } catch (err) {
      recordError("elevenlabs_post_call", err, {
        conversation_id: body.conversation_id,
      });
    }
  };

  waitUntil(processPostCall());
  return c.json({ ok: true });
});
