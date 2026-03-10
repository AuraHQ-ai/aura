import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { waitUntil } from "@vercel/functions";
import { cronApp } from "./cron/consolidate.js";
import { heartbeatApp } from "./cron/heartbeat.js";
import { elevenlabsWebhookApp } from "./webhook/elevenlabs.js";
import { runPipeline } from "./pipeline/index.js";
import {
  publishHomeTab,
  ACTION_TO_SETTING,
  CREDENTIAL_ACTIONS,
  isAdmin,
  openCredentialModal,
  openAddCredentialModal,
  buildAddCredentialBlocks,
  openUpdateCredentialModal,
  openShareCredentialModal,
  openCredentialAccessModal,
} from "./slack/home.js";
import {
  storeApiCredential,
  deleteApiCredential,
  grantApiCredentialAccess,
  listApiCredentials,
  hasPermission,
} from "./lib/api-credentials.js";
import { resolveConfirmation } from "./lib/confirmation.js";
import { handleApprovalReaction } from "./lib/approval.js";
import { executionContext } from "./lib/tool.js";
import { setSetting } from "./lib/settings.js";
import { logger } from "./lib/logger.js";
import { recordError } from "./lib/metrics.js";
import { safePostMessage } from "./lib/slack-messaging.js";
import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { notes, feedback } from "@aura/db/schema";

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

// Mount ElevenLabs voice webhook routes
app.route("/api/webhook/elevenlabs", elevenlabsWebhookApp);

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

    // Handle reaction events -- store as memory + governance approval
    if (event.type === "reaction_added" && event.user && event.item) {
      const reactionPromise = (async () => {
        try {
          // ── Governance: check if this is an approval/rejection reaction ──
          if (
            event.item?.type === "message" &&
            ["white_check_mark", "x"].includes(event.reaction)
          ) {
            try {
              const msgResult = await slackClient.conversations.history({
                channel: event.item.channel,
                latest: event.item.ts,
                limit: 1,
                inclusive: true,
              });
              const msg = msgResult.messages?.[0];
              const actionLogId = (msg?.metadata as any)?.event_payload?.action_log_id;

              if (actionLogId) {
                await handleApprovalReaction({
                  actionLogId,
                  reaction: event.reaction,
                  reactorUserId: event.user,
                  slackClient,
                });
                return;
              }
            } catch (approvalErr) {
              logger.warn("Failed to process approval reaction", { error: approvalErr });
            }
          }

          // ── Store as a lightweight memory via the store module ──
          let userName = event.user;
          try {
            const userResult = await slackClient.users.info({ user: event.user });
            userName =
              userResult.user?.profile?.display_name ||
              userResult.user?.real_name ||
              userResult.user?.name ||
              event.user;
          } catch {}

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

    // Run pipeline asynchronously inside governance execution context.
    // On Vercel, we must acknowledge within 3 seconds, so we process
    // in the background using waitUntil where available.
    const userId = event.user || "unknown";
    const pipelinePromise = executionContext.run(
      {
        triggeredBy: userId,
        triggerType: "user_message",
        channelId: event.channel || undefined,
        threadTs: event.thread_ts || event.ts || undefined,
      },
      () =>
        runPipeline({
          event,
          client: slackClient,
          botUserId,
          teamId: body.team_id,
        }),
    ).catch((err) => {
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
        const messageTs = payload.message?.ts;
        const channelId = payload.channel?.id;

        logger.info("Response feedback received", {
          userId,
          feedback: action.value,
          messageTs,
          channelId,
        });

        if (messageTs && channelId && userId) {
          const feedbackPromise = (async () => {
            try {
              await db.insert(feedback).values({
                messageTs,
                channelId,
                userId,
                value: action.value,
              }).onConflictDoUpdate({
                target: [feedback.messageTs, feedback.channelId, feedback.userId],
                set: { value: sql`excluded.value` },
              });

              if (action.value === "negative") {
                const threadTs = payload.message?.thread_ts || messageTs;
                const replies = await slackClient.conversations.replies({
                  channel: channelId,
                  ts: threadTs,
                  limit: 50,
                });
                const alreadyAsked = replies.messages?.some(
                  (m) => m.bot_id && m.text?.includes("What could I have done better?"),
                );
                if (!alreadyAsked) {
                  await safePostMessage(slackClient, {
                    channel: channelId,
                    thread_ts: threadTs,
                    text: "What could I have done better?",
                  });
                }
              }
            } catch (err) {
              recordError("feedback.persist", err, { userId, messageTs, channelId });
            }
          })();
          waitUntil(feedbackPromise);
        }
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

      // ── User API Credential actions ──────────────────────────────────
      if (action.action_id === "api_credential_add" && payload.trigger_id) {
        const addPromise = openAddCredentialModal(
          slackClient,
          payload.trigger_id,
        ).catch((err) => {
          recordError("interactions.api_credential_add_modal", err, { userId });
        });
        waitUntil(addPromise);
      }

      // Dynamic modal: swap fields when credential type changes
      if (action.action_id === "cred_type" && payload.view) {
        const selectedType = (action.selected_option?.value || "token") as "token" | "oauth_client";
        // Preserve the name field value if already filled
        const currentName = payload.view.state?.values?.cred_name_block?.cred_name?.value || "";
        const blocks = buildAddCredentialBlocks(selectedType);
        // Inject current name value into the block
        if (currentName) {
          const nameBlock = blocks.find((b: any) => b.block_id === "cred_name_block");
          if (nameBlock) {
            nameBlock.element.initial_value = currentName;
          }
        }
        const updatePromise = slackClient.views.update({
          view_id: payload.view.id,
          hash: payload.view.hash,
          view: {
            type: "modal",
            callback_id: "api_credential_add_submit",
            title: { type: "plain_text", text: "Add API Credential" },
            submit: { type: "plain_text", text: "Save" },
            close: { type: "plain_text", text: "Cancel" },
            blocks,
          },
        }).catch((err: unknown) => {
          recordError("interactions.cred_type_switch", err, { userId, selectedType });
        });
        waitUntil(updatePromise);
      }

      // Overflow menu actions (Update/Share/Delete)
      if (action.action_id?.startsWith("api_credential_overflow_") && action.selected_option?.value) {
        const selectedValue = action.selected_option.value as string;

        if (selectedValue.startsWith("api_credential_update_")) {
          const credId = selectedValue.replace("api_credential_update_", "");
          if (payload.trigger_id) {
            const creds = await listApiCredentials(userId);
            const cred = creds.find((c) => c.id === credId);
            const credName = cred?.name ?? "credential";
            const updatePromise = openUpdateCredentialModal(
              slackClient,
              payload.trigger_id,
              credId,
              credName,
            ).catch((err) => {
              recordError("interactions.api_credential_update_modal", err, { userId, credId });
            });
            waitUntil(updatePromise);
          }
        } else if (selectedValue.startsWith("api_credential_share_")) {
          const credId = selectedValue.replace("api_credential_share_", "");
          if (payload.trigger_id) {
            const sharePromise = openShareCredentialModal(
              slackClient,
              payload.trigger_id,
              credId,
            ).catch((err) => {
              recordError("interactions.api_credential_share_modal", err, { userId, credId });
            });
            waitUntil(sharePromise);
          }
        } else if (selectedValue.startsWith("api_credential_delete_")) {
          const credId = selectedValue.replace("api_credential_delete_", "");
          const deletePromise = (async () => {
            try {
              await deleteApiCredential(credId, userId);
              await publishHomeTab(slackClient, userId);
            } catch (err) {
              recordError("interactions.api_credential_delete", err, { userId, credId });
            }
          })();
          waitUntil(deletePromise);
        } else if (selectedValue.startsWith("api_credential_access_") && payload.trigger_id) {
          const rest = selectedValue.slice("api_credential_access_".length);
          const lastUnderscore = rest.lastIndexOf("_");
          const credId = lastUnderscore > 0 ? rest.substring(0, lastUnderscore) : rest;
          const accessPromise = openCredentialAccessModal(
            slackClient,
            payload.trigger_id,
            credId,
          ).catch((err) => {
            recordError("interactions.api_credential_access_modal", err, { userId, credId });
          });
          waitUntil(accessPromise);
        }
      }

      // ── Confirmation buttons (Phase 4) ──────────────────────────────
      if (action.action_id?.startsWith("confirm_approve_")) {
        const token = action.action_id.replace("confirm_approve_", "");
        const approvePromise = (async () => {
          try {
            const entry = resolveConfirmation(token, true);
            if (entry && entry.userId === userId) {
              const channelId = payload.channel?.id;
              if (channelId) {
                await slackClient.chat.postMessage({
                  channel: channelId,
                  text: `Approved: ${entry.action}`,
                });
              }
            }
          } catch (err) {
            recordError("interactions.confirm_approve", err, { userId });
          }
        })();
        waitUntil(approvePromise);
      }

      if (action.action_id?.startsWith("confirm_deny_")) {
        const token = action.action_id.replace("confirm_deny_", "");
        const denyPromise = (async () => {
          try {
            const entry = resolveConfirmation(token, false);
            if (entry && entry.userId === userId) {
              const channelId = payload.channel?.id;
              if (channelId) {
                await slackClient.chat.postMessage({
                  channel: channelId,
                  text: `Denied: ${entry.action}`,
                });
              }
            } else if (entry && entry.userId !== userId) {
              const channelId = payload.channel?.id;
              if (channelId) {
                await slackClient.chat.postEphemeral({
                  channel: channelId,
                  user: userId,
                  text: "You can only deny your own confirmation requests.",
                });
              }
            }
          } catch (err) {
            recordError("interactions.confirm_deny", err, { userId });
          }
        })();
        waitUntil(denyPromise);
      }

      // ── Governance approval buttons ─────────────────────────────────
      if (action.action_id?.startsWith("governance_approve_")) {
        const actionLogId = action.action_id.replace("governance_approve_", "");
        const approvePromise = (async () => {
          try {
            const { handleApprovalReaction } = await import("./lib/approval.js");
            await handleApprovalReaction({
              actionLogId,
              reaction: "white_check_mark",
              reactorUserId: userId,
              slackClient,
            });
            const gaChanId = payload.channel?.id;
            const gaTs = payload.message?.ts;
            if (gaChanId && gaTs) {
              await slackClient.chat.update({
                channel: gaChanId,
                ts: gaTs,
                text: `✅ Approved by <@${userId}>`,
                blocks: [{ type: "section" as const, text: { type: "mrkdwn" as const, text: `✅ *Approved* by <@${userId}>` } }],
              });
            }
          } catch (err) {
            recordError("interactions.governance_approve", err, { userId, actionLogId });
          }
        })();
        waitUntil(approvePromise);
      }

      if (action.action_id?.startsWith("governance_reject_")) {
        const actionLogId = action.action_id.replace("governance_reject_", "");
        const rejectPromise = (async () => {
          try {
            const { handleApprovalReaction } = await import("./lib/approval.js");
            await handleApprovalReaction({
              actionLogId,
              reaction: "x",
              reactorUserId: userId,
              slackClient,
            });
            const grChanId = payload.channel?.id;
            const grTs = payload.message?.ts;
            if (grChanId && grTs) {
              await slackClient.chat.update({
                channel: grChanId,
                ts: grTs,
                text: `❌ Rejected by <@${userId}>`,
                blocks: [{ type: "section" as const, text: { type: "mrkdwn" as const, text: `❌ *Rejected* by <@${userId}>` } }],
              });
            }
          } catch (err) {
            recordError("interactions.governance_reject", err, { userId, actionLogId });
          }
        })();
        waitUntil(rejectPromise);
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

    if (callbackId === "api_credential_add_submit" && userId) {
      const name = payload.view?.state?.values?.cred_name_block?.cred_name?.value;
      const expiryStr = payload.view?.state?.values?.cred_expiry_block?.cred_expiry?.selected_date;
      const credType = (payload.view?.state?.values?.cred_type_block?.cred_type?.selected_option?.value || "token") as "token" | "oauth_client";

      let value: string | undefined;
      let tokenUrl: string | undefined;
      if (credType === "oauth_client") {
        const clientId = payload.view?.state?.values?.cred_client_id_block?.cred_client_id?.value;
        const clientSecret = payload.view?.state?.values?.cred_client_secret_block?.cred_client_secret?.value;
        tokenUrl = payload.view?.state?.values?.cred_token_url_block?.cred_token_url?.value || undefined;
        if (clientId && clientSecret) {
          value = JSON.stringify({ client_id: clientId, client_secret: clientSecret });
        }
      } else {
        value = payload.view?.state?.values?.cred_value_block?.cred_value?.value;
      }

      if (name && value) {

        const expiresAt = expiryStr ? new Date(expiryStr) : undefined;
        const addPromise = (async () => {
          try {
            await storeApiCredential(userId, name, value, expiresAt, credType, tokenUrl);
            await publishHomeTab(slackClient, userId);
          } catch (err) {
            recordError("interactions.api_credential_add", err, { userId, name });
          }
        })();
        waitUntil(addPromise);
      }
    }

    if (callbackId === "api_credential_update_submit" && userId) {
      const credentialId = payload.view?.private_metadata;
      const value = payload.view?.state?.values?.cred_value_block?.cred_value?.value;

      if (credentialId && value) {
        const updatePromise = (async () => {
          try {
            const creds = await listApiCredentials(userId);
            const cred = creds.find((c) => c.id === credentialId);
            if (!cred) return;

            const allowed = await hasPermission(cred.owner_id, cred.id, userId, "write");
            if (!allowed) {
              await slackClient.chat.postEphemeral({
                channel: userId,
                user: userId,
                text: `Permission denied: you don't have write access to credential "${cred.name}".`,
              });
              return;
            }

            await storeApiCredential(cred.owner_id, cred.name, value, cred.expires_at ?? undefined, (cred.type as "token" | "oauth_client") ?? "token");
            await publishHomeTab(slackClient, userId);
          } catch (err) {
            recordError("interactions.api_credential_update", err, { userId, credentialId });
          }
        })();
        waitUntil(updatePromise);
      }
    }

    if (callbackId === "api_credential_share_submit" && userId) {
      const credentialId = payload.view?.private_metadata;
      const granteeId = payload.view?.state?.values?.share_users_block?.share_user?.selected_user;
      const permission = payload.view?.state?.values?.share_permission_block?.share_permission?.selected_option?.value;

      if (credentialId && granteeId && permission) {
        const sharePromise = (async () => {
          try {
            await grantApiCredentialAccess(credentialId, userId, granteeId, permission as "read" | "write" | "admin");
            await publishHomeTab(slackClient, userId);
          } catch (err) {
            recordError("interactions.api_credential_share", err, { userId, credentialId });
          }
        })();
        waitUntil(sharePromise);
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
  const { generateAuthUrlForUser } = await import("./lib/gmail.js");

  if (userId) {
    const authHeader = c.req.header("authorization") || "";
    const expectedSecret = signingSecret;
    if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  const resolvedUserId = userId || process.env.AURA_BOT_USER_ID || "aura";
  const url = generateAuthUrlForUser(resolvedUserId);
  if (!url) return c.json({ error: "Gmail OAuth not configured" }, 500);

  return c.json({
    url,
    instructions: userId
      ? `Open this URL in a browser logged in as the Gmail account for Slack user ${userId}`
      : "Open this URL in a browser logged in as your Aura email account",
  });
});

app.get("/api/oauth/google/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "No auth code received" }, 400);

  // Parse state to get user_id — always required now
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

  // Fallback for legacy auth URLs without state
  if (!userId) {
    userId = process.env.AURA_BOT_USER_ID || "aura";
  }

  const { exchangeCodeForTokens, saveUserRefreshToken } = await import("./lib/gmail.js");
  const result = await exchangeCodeForTokens(code);
  if (!result.refreshToken) return c.json({ error: "Token exchange failed", detail: result.error || "No refresh token returned" }, 500);

  // Always save to oauth_tokens table, keyed by (user_id, provider)
  try {
    await saveUserRefreshToken(userId, result.refreshToken, result.email);
    logger.info("OAuth refresh token saved to oauth_tokens", { userId, email: result.email });
    return c.json({
      success: true,
      message: `Gmail connected for ${userId}! Refresh token saved. Active immediately — no redeploy needed.`,
    });
  } catch (saveError: any) {
    logger.error("Failed to save refresh token to oauth_tokens", { userId, error: saveError.message });
    return c.json({
      success: false,
      error: `Failed to save token: ${saveError.message}`,
    }, 500);
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
                if ((ghRes as any).ok) {
                  const prData = (await (ghRes as any).json()) as any;
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
        await safePostMessage(slackClient, {
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
        await safePostMessage(slackClient, {
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

export default app;
