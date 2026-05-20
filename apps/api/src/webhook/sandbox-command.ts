import { Hono } from "hono";
import type { WebClient } from "@slack/web-api";
import crypto from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { detachedCommands, type DetachedCommand } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { recordError } from "../lib/metrics.js";
import { safePostMessage } from "../lib/slack-messaging.js";

const MAX_TAIL_CHARS = 16 * 1024;
const SLACK_TAIL_CHARS = 4_000;

const payloadSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{8}$/),
  exit_code: z.number().int(),
  stdout_tail: z.string().default(""),
  stderr_tail: z.string().default(""),
});

export function verifySandboxWebhookSignature(
  rawBody: string,
  signature: string,
  secret = process.env.SANDBOX_WEBHOOK_SECRET,
): boolean {
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

function truncateTail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

function sanitizeCodeBlock(value: string): string {
  return value.replace(/```/g, "`\u200b``");
}

function formatInlineCode(value: string): string {
  return value.replace(/`/g, "'");
}

function runtimeSeconds(row: DetachedCommand, completedAt: Date): number {
  return Math.max(0, Math.floor((completedAt.getTime() - row.startedAt.getTime()) / 1000));
}

function formatTailBlock(label: string, value: string): string {
  const tail = truncateTail(value.trim(), SLACK_TAIL_CHARS);
  if (!tail) return "";
  return `\n\n*${label}:*\n\`\`\`\n${sanitizeCodeBlock(tail)}\n\`\`\``;
}

export function buildSandboxCommandNotification(
  row: DetachedCommand,
  exitCode: number,
  stdoutTail: string,
  stderrTail: string,
  completedAt = new Date(),
): string {
  const status = exitCode === 0 ? "completed" : "failed";
  const command = formatInlineCode(row.command);
  const runtime = runtimeSeconds(row, completedAt);
  const header =
    `:gear: Detached command \`${row.id}\` ${status} with exit code ${exitCode}.`;
  const commandLine = command ? `\n_Command:_ \`${command.slice(0, 180)}\`` : "";
  const runtimeLine = `\n_Runtime:_ ${runtime}s`;
  const stdoutBlock = formatTailBlock("stdout tail", stdoutTail);
  const stderrBlock = formatTailBlock("stderr tail", stderrTail);

  return `${header}${commandLine}${runtimeLine}${stdoutBlock}${stderrBlock}`;
}

export function createSandboxCommandWebhookApp(
  slackClient: WebClient,
  database: any = db,
) {
  const app = new Hono();

  app.post("/", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("x-webhook-signature") || "";

    if (!process.env.SANDBOX_WEBHOOK_SECRET) {
      logger.warn("SANDBOX_WEBHOOK_SECRET not configured, rejecting sandbox webhook");
      return c.json({ error: "Webhook not configured" }, 403);
    }

    if (!verifySandboxWebhookSignature(rawBody, signature)) {
      logger.warn("Invalid sandbox command webhook signature, rejecting");
      return c.json({ error: "Invalid signature" }, 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = payloadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid payload" }, 400);
    }

    const payload = parsed.data;
    const completedAt = new Date();
    const status = payload.exit_code === 0 ? "completed" : "failed";
    const stdoutTail = truncateTail(payload.stdout_tail, MAX_TAIL_CHARS);
    const stderrTail = truncateTail(payload.stderr_tail, MAX_TAIL_CHARS);

    try {
      const rows = await database
        .select()
        .from(detachedCommands)
        .where(eq(detachedCommands.id, payload.id))
        .limit(1);
      const existing = rows[0] as DetachedCommand | undefined;

      if (!existing) {
        logger.warn("Sandbox command webhook received for unknown command", {
          id: payload.id,
        });
        return c.json({ ok: true, notified: false });
      }

      const shouldNotify = existing.status === "running";
      const updatedRows = await database
        .update(detachedCommands)
        .set({
          status,
          exitCode: payload.exit_code,
          completedAt,
          stdoutTail,
          stderrTail,
        })
        .where(eq(detachedCommands.id, payload.id))
        .returning();
      const updated = (updatedRows[0] as DetachedCommand | undefined) ?? {
        ...existing,
        status,
        exitCode: payload.exit_code,
        completedAt,
        stdoutTail,
        stderrTail,
      };

      let notified = false;
      if (!shouldNotify) {
        logger.info("Sandbox command webhook already notified, skipping Slack post", {
          id: payload.id,
          previousStatus: existing.status,
          status,
        });
        return c.json({ ok: true, notified: false, reason: "already_notified" });
      }

      if (updated.channelId) {
        try {
          await safePostMessage(slackClient, {
            channel: updated.channelId,
            thread_ts: updated.threadTs || undefined,
            text: buildSandboxCommandNotification(
              updated,
              payload.exit_code,
              stdoutTail,
              stderrTail,
              completedAt,
            ),
            unfurl_links: false,
            unfurl_media: false,
          });
          notified = true;
        } catch (error) {
          recordError("sandbox_command_webhook_slack_notify", error, {
            id: payload.id,
            channelId: updated.channelId,
          });
        }
      }

      logger.info("Sandbox command webhook processed", {
        id: payload.id,
        status,
        exitCode: payload.exit_code,
        notified,
      });

      return c.json({ ok: true, notified });
    } catch (error) {
      recordError("sandbox_command_webhook", error, { id: payload.id });
      return c.json({ error: "Webhook processing failed" }, 500);
    }
  });

  return app;
}
