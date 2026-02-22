import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { waitUntil } from "@vercel/functions";
import { cronApp } from "./cron/consolidate.js";
import { heartbeatApp } from "./cron/heartbeat.js";
import { runPipeline } from "./pipeline/index.js";
import { publishHomeTab, ACTION_TO_SETTING, CREDENTIAL_ACTIONS, isAdmin, openCredentialModal } from "./slack/home.js";
import { setSetting } from "./lib/settings.js";
import { logger } from "./lib/logger.js";
import { recordError } from "./lib/metrics.js";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { notes } from "./db/schema.js";

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
app.route("/", heartbeatApp);

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

    // Handle reaction events -- store as memory for awareness
    if (event.type === "reaction_added" && event.user && event.item) {
      const reactionPromise = (async () => {
        try {
          // Resolve user name for the memory
          let userName = event.user;
          try {
            const userResult = await slackClient.users.info({ user: event.user });
            userName =
              userResult.user?.profile?.display_name ||
              userResult.user?.real_name ||
              userResult.user?.name ||
              event.user;
          } catch {}

          // Store as a lightweight memory via the store module
          const { storeMessage } = await import("./memory/store.js");
          await storeMessage({
            slackTs: `reaction-${event.event_ts}`,
            channelId: event.item.channel || "",
            channelType: "public_channel",
            userId: event.user,
            role: "user",
            content: `${userName} reacted with :${event.reaction}: to a message`,
          });

          logger.info("Reaction event stored", {
            user: userName,
            reaction: event.reaction,
            channel: event.item.channel,
          });
        } catch (err) {
          recordError("reaction_event", err, { userId: event.user });
        }
      })();
      waitUntil(reactionPromise);
      return c.json({ ok: true });
    }

    // Handle assistant thread started — set suggested prompts in split-view
    if (event.type === "assistant_thread_started") {
      const threadStartPromise = (async () => {
        try {
          const channelId = event.assistant_thread?.channel_id;
          const threadTs = event.assistant_thread?.thread_ts;
          if (!channelId || !threadTs) return;

          await slackClient.assistant.threads.setSuggestedPrompts({
            channel_id: channelId,
            thread_ts: threadTs,
            title: "How can I help?",
            prompts: [
              { title: "Catch me up", message: "What happened in my channels while I was away?" },
              { title: "Run a query", message: "Show me this week's key metrics from BigQuery" },
              { title: "Search Slack", message: "Find recent messages about..." },
              { title: "What do you know?", message: "What do you know about me?" },
            ],
          });
        } catch (err) {
          recordError("assistant_thread_started", err);
        }
      })();
      waitUntil(threadStartPromise);
      return c.json({ ok: true });
    }

    // Handle App Home opened
    if (event.type === "app_home_opened") {
      const homePromise = publishHomeTab(slackClient, event.user).catch(
        (err) => {
          recordError("app_home", err, { userId: event.user });
        },
      );
      waitUntil(homePromise);
      return c.json({ ok: true });
    }

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
      teamId: body.team_id,
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

// ── Slack Interactions Endpoint ─────────────────────────────────────────────

app.post("/api/slack/interactions", async (c) => {
  const rawBody = await c.req.text();

  // Verify signature (same as events)
  const timestamp = c.req.header("x-slack-request-timestamp") || "";
  const signature = c.req.header("x-slack-signature") || "";

  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    logger.warn("Invalid Slack signature on interactions endpoint");
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Parse the payload (URL-encoded form with a `payload` field)
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  if (!payloadStr) {
    return c.json({ error: "Missing payload" }, 400);
  }

  let payload: any;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return c.json({ error: "Invalid payload JSON" }, 400);
  }

  // Handle block_actions
  if (payload.type === "block_actions" && payload.actions) {
    const userId = payload.user?.id;

    for (const action of payload.actions) {
      // Feedback buttons — any user can submit
      if (action.action_id === "aura_feedback") {
        logger.info("Response feedback received", {
          userId,
          feedback: action.value,
          messageTs: payload.message?.ts,
          channelId: payload.channel?.id,
        });
        continue;
      }

      // Admin-only settings changes
      if (!userId || !isAdmin(userId)) {
        logger.warn("Non-admin attempted settings change", { userId });
        continue;
      }

      const settingKey = ACTION_TO_SETTING[action.action_id];
      if (settingKey && action.selected_option?.value) {
        const newValue = action.selected_option.value;

        const savePromise = (async () => {
          try {
            await setSetting(settingKey, newValue, userId);
            await publishHomeTab(slackClient, userId);
          } catch (err) {
            recordError("interactions.save", err, { userId, settingKey });
          }
        })();

        waitUntil(savePromise);
      }

      const credentialKey = CREDENTIAL_ACTIONS[action.action_id];
      if (credentialKey && payload.trigger_id) {
        const modalPromise = openCredentialModal(
          slackClient,
          payload.trigger_id,
          credentialKey,
        ).catch((err) => {
          recordError("interactions.credential_modal", err, {
            userId,
            credentialKey,
          });
        });
        waitUntil(modalPromise);
      }
    }
  }

  if (payload.type === "view_submission") {
    const callbackId = payload.view?.callback_id;
    const userId = payload.user?.id;

    if (callbackId === "credential_submit" && userId && isAdmin(userId)) {
      const credentialKey = payload.view?.private_metadata;
      const newValue =
        payload.view?.state?.values?.credential_input_block?.credential_value
          ?.value;

      if (credentialKey && newValue) {
        const savePromise = (async () => {
          try {
            const { setCredential } = await import("./lib/credentials.js");
            await setCredential(credentialKey, newValue, userId);
            await publishHomeTab(slackClient, userId);
          } catch (err) {
            recordError("interactions.credential_save", err, {
              userId,
              credentialKey,
            });
          }
        })();
        waitUntil(savePromise);
      }
    }

    // Slack modals require empty response or response_action to close properly
    return c.json({ response_action: "clear" });
  }

  // Acknowledge immediately
  return c.json({ ok: true });
});

// ── Google OAuth Routes (Gmail) ─────────────────────────────────────────────

app.get("/api/oauth/google/auth-url", async (c) => {
  const userId = c.req.query("user_id");
  const { generateAuthUrl, generateAuthUrlForUser } = await import("./lib/gmail.js");

  if (userId) {
    const authHeader = c.req.header("authorization") || "";
    const expectedSecret = signingSecret;
    if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  const url = userId ? generateAuthUrlForUser(userId) : generateAuthUrl();
  if (!url) return c.json({ error: "Gmail OAuth not configured" }, 500);

  return c.json({
    url,
    instructions: userId
      ? `Open this URL in a browser logged in as the Gmail account for Slack user ${userId}`
      : "Open this URL in a browser logged in as aura@realadvisor.com",
  });
});

app.get("/api/oauth/google/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "No auth code received" }, 400);

  // Parse state to check for user_id (multi-user OAuth flow)
  const stateParam = c.req.query("state");
  let userId: string | undefined;
  if (stateParam) {
    const { verifyOAuthState } = await import("./lib/gmail.js");
    const verified = verifyOAuthState(stateParam);
    if (verified) {
      userId = verified;
    } else {
      return c.json({ error: "Invalid or expired OAuth state" }, 403);
    }
  }

  const { exchangeCodeForTokens, saveRefreshToken, saveUserRefreshToken } = await import("./lib/gmail.js");
  const result = await exchangeCodeForTokens(code);
  if (!result.refreshToken) return c.json({ error: "Token exchange failed", detail: result.error || "No refresh token returned" }, 500);

  // Multi-user flow: save to oauth_tokens table
  if (userId) {
    try {
      await saveUserRefreshToken(userId, result.refreshToken, result.email);
      logger.info("User OAuth refresh token saved to database", { userId, email: result.email });
      return c.json({
        success: true,
        message: `Gmail connected for user ${userId}! Refresh token saved. Aura can now access this Gmail account.`,
      });
    } catch (saveError: any) {
      logger.error("Failed to save user refresh token", { userId, error: saveError.message });
      return c.json({
        success: false,
        error: `Failed to save token for user ${userId}: ${saveError.message}`,
      }, 500);
    }
  }

  // Default flow: save to settings table (backward compatible — aura@realadvisor.com)
  try {
    await saveRefreshToken(result.refreshToken);
    logger.info("OAuth refresh token saved to database");
    return c.json({
      success: true,
      message: "Gmail connected! Refresh token saved to database. Email is active immediately — no redeploy needed.",
    });
  } catch (saveError: any) {
    logger.error("Failed to save refresh token to database", { error: saveError.message });
    return c.json({
      success: true,
      refresh_token: result.refreshToken,
      instructions:
        "Auto-save to database failed. Add this refresh token as GOOGLE_EMAIL_REFRESH_TOKEN in Vercel env vars, then redeploy.",
    });
  }
});

// ── Cursor Agent Webhook ───────────────────────────────────────────────────

function verifyCursorWebhookSignature(
  rawBody: string,
  signature: string,
): boolean {
  const secret = process.env.CURSOR_WEBHOOK_SECRET;
  if (!secret || !signature) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(signature, "utf8"),
    );
  } catch {
    return false;
  }
}

app.post("/api/webhook/cursor-agent", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-webhook-signature") || "";

  if (!process.env.CURSOR_WEBHOOK_SECRET) {
    logger.warn("CURSOR_WEBHOOK_SECRET not configured — rejecting webhook");
    return c.json({ error: "Webhook not configured" }, 403);
  }

  if (!verifyCursorWebhookSignature(rawBody, signature)) {
    logger.warn("Invalid Cursor webhook signature — rejecting");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const agentId: string = payload.id || payload.agentId || "";
  const status: string = payload.status || payload.event || "";
  const prUrl: string = payload.target?.prUrl || payload.prUrl || "";
  const branchName: string =
    payload.target?.branchName || payload.branchName || "";
  const summary: string = payload.summary || "";
  const webhookId = c.req.header("x-webhook-id") || "";

  logger.info("Cursor agent webhook received", {
    agentId,
    status,
    webhookId,
    prUrl,
  });

  const processWebhook = async () => {
    try {
      let requester = "";
      let channelId = "";
      let threadTs = "";

      if (agentId) {
        const trackingRows = await db
          .select({ content: notes.content })
          .from(notes)
          .where(eq(notes.topic, `cursor-agent:${agentId}`))
          .limit(1);

        if (trackingRows[0]?.content) {
          const content = trackingRows[0].content;
          const requesterMatch = content.match(
            /\*\*Requester\*\*:\s*(\S+)/,
          );
          const channelMatch = content.match(/\*\*Channel\*\*:\s*(\S+)/);
          const threadMatch = content.match(/\*\*Thread\*\*:\s*(\S+)/);
          if (requesterMatch && requesterMatch[1] !== "unknown")
            requester = requesterMatch[1];
          if (channelMatch) channelId = channelMatch[1];
          if (threadMatch && threadMatch[1] !== "none")
            threadTs = threadMatch[1];
        }
      }

      const adminIds = (process.env.AURA_ADMIN_USER_IDS || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const dmTarget = requester || adminIds[0];

      if (!dmTarget) {
        logger.warn("Cursor agent webhook: no DM target found", { agentId });
        return;
      }

      const isFinished =
        status.toLowerCase() === "finished" ||
        status.toLowerCase() === "completed";
      const isError =
        status.toLowerCase() === "error" ||
        status.toLowerCase() === "failed";

      let prTitle = "";
      if (prUrl) {
        const prMatch = prUrl.match(/\/pull\/(\d+)$/);
        if (prMatch) {
          try {
            const { getCredential } = await import("./lib/credentials.js");
            const ghToken = await getCredential("github_token");
            if (ghToken) {
              const prNumber = prMatch[1];
              const repoMatch = prUrl.match(
                /github\.com\/([^/]+\/[^/]+)\/pull/,
              );
              if (repoMatch) {
                const ghRes = await fetch(
                  `https://api.github.com/repos/${repoMatch[1]}/pulls/${prNumber}`,
                  {
                    headers: {
                      Authorization: `token ${ghToken}`,
                      Accept: "application/vnd.github.v3+json",
                    },
                  },
                );
                if (ghRes.ok) {
                  const prData = (await ghRes.json()) as any;
                  prTitle = prData.title || "";
                }
              }
            }
          } catch {
            /* fallback to no title */
          }
        }
      }

      let message: string;
      if (isFinished) {
        const safePrTitle = prTitle
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\|/g, "\u2758");
        const prLine = prUrl
          ? safePrTitle
            ? `\u2705 *<${prUrl}|${safePrTitle}>*`
            : `\u2705 *<${prUrl}|PR>*`
          : "\u2705 Agent finished";
        const branchLine = branchName
          ? `\n_Branch:_ \`${branchName}\``
          : "";
        const summaryLine = summary ? `\n\n${summary}` : "";
        message = `${prLine}${branchLine}${summaryLine}`;
      } else if (isError) {
        message = `\u274C Agent *failed*${summary ? `\n\n${summary}` : ""}`;
      } else {
        message = `Agent status: *${status}*`;
      }

      if (isFinished && agentId) {
        try {
          const { getCursorConversation } = await import(
            "./lib/cursor-agent.js"
          );
          const conversation = await getCursorConversation(agentId);
          if (conversation?.summary) {
            message += `\n\n_${conversation.summary}_`;
          }
        } catch {
          /* non-critical */
        }
      }

      const dmResult = await slackClient.conversations.open({
        users: dmTarget,
      });
      const dmChannelId = dmResult.channel?.id;

      if (dmChannelId) {
        const useThreadTs =
          channelId === dmChannelId && threadTs ? threadTs : undefined;
        await slackClient.chat.postMessage({
          channel: dmChannelId,
          thread_ts: useThreadTs,
          text: message,
        });
        logger.info("Cursor agent webhook: DM sent", {
          agentId,
          target: dmTarget,
          status,
        });
      }

      if (
        channelId &&
        channelId !== "unknown" &&
        channelId !== dmChannelId
      ) {
        await slackClient.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs || undefined,
          text: message,
        });
        logger.info("Cursor agent webhook: thread notification sent", {
          agentId,
          channelId,
          threadTs,
          status,
        });
      }
    } catch (err) {
      recordError("cursor_agent_webhook", err, { agentId, status });
    }
  };

  waitUntil(processWebhook());
  return c.json({ ok: true });
});

// ── GitHub Webhook ─────────────────────────────────────────────────────────

function verifyGitHubWebhookSignature(
  rawBody: string,
  signature: string,
): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !signature) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(signature, "utf8"),
    );
  } catch {
    return false;
  }
}

const GITHUB_EVENT_SYSTEM_PROMPT = `You are a GitHub event handler for the Aura repo (realadvisor/aura). You receive GitHub webhook payloads and decide what actions to take.

For pull_request events:
- "opened" with draft=false OR "ready_for_review": Check if the PR body references issues (Fixes #N, Closes #N). Post a summary to the relevant Slack thread if one exists.
- "closed" with merged=true: Find referenced issues and close them with \`gh issue close\`. Notify relevant Slack conversations.
- "opened" with draft=true: If the PR references an issue, consider marking it ready for review with \`gh pr ready\`.

Rules:
- Be concise in Slack notifications. One or two sentences max.
- Don't spam. Only notify when it genuinely matters.
- When closing issues, verify the PR actually addresses them (check the diff summary).
- Update the gap-issue-pr-map note if relevant.
- Always include links in notifications.`;

app.post("/api/webhook/github", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") || "";
  const eventType = c.req.header("x-github-event") || "";

  if (!process.env.GITHUB_WEBHOOK_SECRET) {
    logger.warn("GITHUB_WEBHOOK_SECRET not configured — rejecting webhook");
    return c.json({ error: "Webhook not configured" }, 403);
  }

  if (!verifyGitHubWebhookSignature(rawBody, signature)) {
    logger.warn("Invalid GitHub webhook signature — rejecting");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  logger.info("GitHub webhook received", {
    event: eventType,
    action: payload.action,
    repo: payload.repository?.full_name,
  });

  if (eventType !== "pull_request") {
    return c.json({ ok: true, skipped: true, reason: `Ignoring event: ${eventType}` });
  }

  const processGitHubEvent = async () => {
    try {
      const { generateText, stepCountIs } = await import("ai");
      const { tool: aiTool } = await import("ai");
      const { z } = await import("zod");
      const { getFastModel } = await import("./lib/ai.js");
      const { execSync } = await import("node:child_process");

      const model = await getFastModel();

      const ghTools = {
        run_gh_command: aiTool({
          description:
            "Run a GitHub CLI (gh) command. Use for operations like closing issues, marking PRs ready, adding labels. The command should start with 'gh' and will run against the realadvisor/aura repo.",
          inputSchema: z.object({
            command: z
              .string()
              .describe(
                "The gh CLI command to run, e.g. 'gh issue close 42 -R realadvisor/aura'",
              ),
          }),
          execute: async ({ command }) => {
            try {
              if (!command.startsWith("gh ")) {
                return { ok: false, error: "Command must start with 'gh'" };
              }
              const ghToken =
                process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
              if (!ghToken) {
                return { ok: false, error: "No GitHub token configured" };
              }
              const output = execSync(command, {
                encoding: "utf8",
                timeout: 15_000,
                env: { ...process.env, GH_TOKEN: ghToken },
              });
              logger.info("run_gh_command executed", {
                command,
                outputLength: output.length,
              });
              return { ok: true, output: output.slice(0, 4000) };
            } catch (err: any) {
              logger.error("run_gh_command failed", {
                command,
                error: err.message,
              });
              return {
                ok: false,
                error: `Command failed: ${err.message?.slice(0, 500)}`,
              };
            }
          },
        }),

        send_slack_message: aiTool({
          description:
            "Post a message to a Slack channel. Use for notifying about PR events.",
          inputSchema: z.object({
            channel: z
              .string()
              .describe("Slack channel ID or name to post to"),
            text: z.string().describe("Message text (Slack mrkdwn format)"),
          }),
          execute: async ({ channel, text }) => {
            try {
              const result = await slackClient.chat.postMessage({
                channel,
                text,
              });
              logger.info("send_slack_message sent", {
                channel,
                ts: result.ts,
              });
              return { ok: true, ts: result.ts };
            } catch (err: any) {
              logger.error("send_slack_message failed", {
                channel,
                error: err.message,
              });
              return { ok: false, error: err.message };
            }
          },
        }),

        send_slack_thread_reply: aiTool({
          description: "Reply in a Slack thread.",
          inputSchema: z.object({
            channel: z.string().describe("Slack channel ID"),
            thread_ts: z
              .string()
              .describe("Thread timestamp to reply in"),
            text: z.string().describe("Reply text (Slack mrkdwn format)"),
          }),
          execute: async ({ channel, thread_ts, text }) => {
            try {
              const result = await slackClient.chat.postMessage({
                channel,
                thread_ts,
                text,
              });
              logger.info("send_slack_thread_reply sent", {
                channel,
                thread_ts,
                ts: result.ts,
              });
              return { ok: true, ts: result.ts };
            } catch (err: any) {
              logger.error("send_slack_thread_reply failed", {
                channel,
                error: err.message,
              });
              return { ok: false, error: err.message };
            }
          },
        }),

        read_note: aiTool({
          description:
            "Read one of Aura's notes by topic. Use to check gap-issue-pr-map or other tracking notes.",
          inputSchema: z.object({
            topic: z.string().describe("The topic key of the note to read"),
          }),
          execute: async ({ topic }) => {
            try {
              const rows = await db
                .select()
                .from(notes)
                .where(eq(notes.topic, topic))
                .limit(1);
              const note = rows[0];
              if (!note) {
                return {
                  ok: false,
                  error: `No note found with topic "${topic}".`,
                };
              }
              return {
                ok: true,
                topic: note.topic,
                category: note.category,
                content: note.content,
                updated_at: note.updatedAt.toISOString(),
              };
            } catch (err: any) {
              return { ok: false, error: err.message };
            }
          },
        }),

        edit_note: aiTool({
          description:
            "Edit an existing note. Supports 'append' to add content at the end.",
          inputSchema: z.object({
            topic: z.string().describe("The topic key of the note to edit"),
            operation: z
              .enum(["append", "prepend"])
              .describe("How to edit: 'append' adds to end, 'prepend' adds to start"),
            content: z.string().describe("The content to add"),
          }),
          execute: async ({ topic, operation, content: newContent }) => {
            try {
              const rows = await db
                .select()
                .from(notes)
                .where(eq(notes.topic, topic))
                .limit(1);
              const note = rows[0];
              if (!note) {
                return {
                  ok: false,
                  error: `No note found with topic "${topic}".`,
                };
              }

              const updated =
                operation === "append"
                  ? note.content + "\n" + newContent
                  : newContent + "\n" + note.content;

              await db
                .update(notes)
                .set({ content: updated, updatedAt: new Date() })
                .where(eq(notes.topic, topic));

              return {
                ok: true,
                message: `Note "${topic}" updated (${operation}).`,
              };
            } catch (err: any) {
              return { ok: false, error: err.message };
            }
          },
        }),
      };

      const result = await generateText({
        model,
        system: GITHUB_EVENT_SYSTEM_PROMPT,
        prompt: JSON.stringify({
          event: eventType,
          action: payload.action,
          payload,
        }),
        tools: ghTools,
        stopWhen: stepCountIs(10),
      });

      logger.info("GitHub webhook Haiku processing complete", {
        event: eventType,
        action: payload.action,
        steps: result.steps.length,
        text: result.text?.slice(0, 200),
      });
    } catch (err) {
      recordError("github_webhook", err, {
        event: eventType,
        action: payload.action,
      });
    }
  };

  waitUntil(processGitHubEvent());
  return c.json({ ok: true });
});

export default app;
