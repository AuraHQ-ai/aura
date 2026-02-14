import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { waitUntil } from "@vercel/functions";
import { cronApp } from "./cron/consolidate.js";
import { runPipeline } from "./pipeline/index.js";
import { logger } from "./lib/logger.js";
import { recordError } from "./lib/metrics.js";
import crypto from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────────────

const signingSecret = process.env.SLACK_SIGNING_SECRET || "";
const botToken = process.env.SLACK_BOT_TOKEN || "";
const botUserId = process.env.AURA_BOT_USER_ID || "";

if (!signingSecret || !botToken) {
  logger.warn(
    "SLACK_SIGNING_SECRET or SLACK_BOT_TOKEN not set — Slack handlers will not work",
  );
}

const slackClient = new WebClient(botToken);

// ── Hono App ────────────────────────────────────────────────────────────────

export const app = new Hono();

// Health check
app.get("/", (c) => {
  return c.json({
    name: "Aura",
    version: "0.1.0",
    status: "alive",
  });
});

app.get("/api/health", (c) => {
  return c.json({ ok: true, timestamp: new Date().toISOString() });
});

// Mount cron routes
app.route("/", cronApp);

// ── Slack Signature Verification ────────────────────────────────────────────

function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
): boolean {
  if (!signingSecret) return false;

  // Reject requests older than 5 minutes (replay attack protection)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  if (parseInt(timestamp) < fiveMinutesAgo) return false;

  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(sigBasestring, "utf8")
      .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(mySignature, "utf8"),
      Buffer.from(signature, "utf8"),
    );
  } catch {
    return false;
  }
}

// ── Slack Retry Detection (must be registered before the handler) ───────────

app.use("/api/slack/*", async (c, next) => {
  // Slack retries events if it doesn't get a 200 within 3 seconds.
  // If we see a retry header, acknowledge without re-processing.
  const retryNum = c.req.header("x-slack-retry-num");
  const retryReason = c.req.header("x-slack-retry-reason");

  if (retryNum) {
    logger.info("Slack retry detected — acknowledging without processing", {
      retryNum,
      retryReason,
    });
    return c.json({ ok: true });
  }

  await next();
});

// ── Slack Events Endpoint ───────────────────────────────────────────────────

app.post("/api/slack/events", async (c) => {
  const rawBody = await c.req.text();

  // Parse the body
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Verify request signature
  const timestamp = c.req.header("x-slack-request-timestamp") || "";
  const signature = c.req.header("x-slack-signature") || "";

  if (!signingSecret) {
    logger.error("SLACK_SIGNING_SECRET is not configured — rejecting request");
    return c.json({ error: "Server misconfigured" }, 500);
  }

  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    logger.warn("Invalid Slack signature — rejecting request");
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Handle Slack URL verification challenge
  if (body.type === "url_verification") {
    logger.info("Slack URL verification challenge received");
    return c.json({ challenge: body.challenge });
  }

  // Process the event
  if (body.event) {
    const event = body.event;

    logger.debug("Dispatching Slack event", {
      type: event.type,
      subtype: event.subtype,
      channel: event.channel,
    });

    // Run pipeline asynchronously.
    // On Vercel, we must acknowledge within 3 seconds, so we process
    // in the background using waitUntil where available.
    const pipelinePromise = runPipeline({
      event,
      client: slackClient,
      botUserId,
    }).catch((err) => {
      recordError("pipeline", err, {
        eventType: event.type,
        channel: event.channel,
      });
    });

    // Keep the function alive after the response is sent so the
    // pipeline can finish (LLM call, Slack reply, memory extraction).
    waitUntil(pipelinePromise);
  }

  // Acknowledge immediately (must happen within 3 seconds for Slack)
  return c.json({ ok: true });
});

export default app;
