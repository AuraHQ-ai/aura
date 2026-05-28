import { Hono } from "hono";
import type { WebClient } from "@slack/web-api";
import { waitUntil } from "@vercel/functions";
import crypto from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { detachedCommands, type DetachedCommand } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { recordError } from "../lib/metrics.js";
import { getConfig } from "../lib/settings.js";
import { executionContext, type ExecutionContext } from "../lib/tool.js";
import { runPipeline } from "../pipeline/index.js";

const MAX_TAIL_CHARS = 16 * 1024;
const RESULT_TAIL_CHARS = 4_000;

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
  const tail = truncateTail(value.trim(), RESULT_TAIL_CHARS);
  if (!tail) return "";
  return `\n\n*${label}:*\n\`\`\`\n${sanitizeCodeBlock(tail)}\n\`\`\``;
}

export function buildDetachedCommandResultMessage(
  row: DetachedCommand,
  exitCode: number,
  stdoutTail: string,
  stderrTail: string,
  completedAt = new Date(),
): string {
  const command = formatInlineCode(row.command);
  const runtime = runtimeSeconds(row, completedAt);
  const commandLine = command ? `\n_Command:_ \`${command}\`` : "";
  const stdoutBlock = formatTailBlock("stdout tail", stdoutTail);
  const stderrBlock = formatTailBlock("stderr tail", stderrTail);

  return `<detached-command-result id="${row.id}" exit_code=${exitCode} runtime_s=${runtime}>${commandLine}${stdoutBlock}${stderrBlock}\n</detached-command-result>`;
}

type ResumeDetachedCommandInput = {
  row: DetachedCommand;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  completedAt: Date;
  slackClient: WebClient;
};

type SandboxCommandWebhookOptions = {
  resumeConversation?: (input: ResumeDetachedCommandInput) => Promise<void>;
  enqueueResume?: (promise: Promise<void>) => void;
};

function makeSyntheticSlackTs(): string {
  const nowMs = Date.now();
  const seconds = Math.floor(nowMs / 1000);
  const micros = (nowMs % 1000) * 1000 + crypto.randomInt(0, 1000);
  return `${seconds}.${String(micros).padStart(6, "0")}`;
}

function inferSyntheticChannelType(channelId: string): string {
  if (channelId.startsWith("D")) return "im";
  if (channelId.startsWith("G")) return "group";
  return "channel";
}

async function getBotUserId(): Promise<string> {
  return await getConfig("aura_bot_user_id");
}

async function resumeDetachedCommandConversation(input: ResumeDetachedCommandInput): Promise<void> {
  const { row, exitCode, stdoutTail, stderrTail, completedAt, slackClient } = input;

  if (!row.channelId || !row.threadTs) {
    logger.warn("Sandbox command webhook cannot resume without origin thread", {
      id: row.id,
      channelId: row.channelId,
      threadTs: row.threadTs,
    });
    return;
  }

  const botUserId = await getBotUserId();
  const syntheticMessage = buildDetachedCommandResultMessage(
    row,
    exitCode,
    stdoutTail,
    stderrTail,
    completedAt,
  );
  const syntheticEvent = {
    type: "app_mention" as const,
    channel: row.channelId,
    ts: makeSyntheticSlackTs(),
    thread_ts: row.threadTs,
    channel_type: inferSyntheticChannelType(row.channelId),
    user: row.requestedBy,
    text: `<@${botUserId}> ${syntheticMessage}`,
  };
  const resumeContext: ExecutionContext = {
    triggeredBy: row.requestedBy,
    triggerType: "user_message",
    callingUserId: row.requestedBy,
    channelId: row.channelId,
    threadTs: row.threadTs,
    workspaceId: row.workspaceId,
  };

  await executionContext.run(resumeContext, async () =>
    runPipeline({
      event: syntheticEvent,
      client: slackClient,
      botUserId,
    })
  );
}

export function createSandboxCommandWebhookApp(
  slackClient: WebClient,
  database: any = db,
  options: SandboxCommandWebhookOptions = {},
) {
  const app = new Hono();
  const resumeConversation = options.resumeConversation ?? resumeDetachedCommandConversation;
  const enqueueResume = options.enqueueResume ?? ((promise: Promise<void>) => waitUntil(promise));

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
        return c.json({ ok: true, resumed: false });
      }

      const shouldResume = existing.status === "running";
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

      let resumed = false;
      if (!shouldResume) {
        logger.info("Sandbox command webhook already resumed, skipping synthetic turn", {
          id: payload.id,
          previousStatus: existing.status,
          status,
        });
        return c.json({ ok: true, resumed: false, reason: "already_notified" });
      }

      if (updated.channelId && updated.threadTs) {
        const resumePromise = resumeConversation({
          row: updated,
          exitCode: payload.exit_code,
          stdoutTail,
          stderrTail,
          completedAt,
          slackClient,
        }).catch((error) => {
          logger.warn("Sandbox command webhook synthetic resume failed", {
            id: payload.id,
            channelId: updated.channelId,
            threadTs: updated.threadTs,
            error: error instanceof Error ? error.message : String(error),
          });
          recordError("sandbox_command_webhook_resume", error, {
            id: payload.id,
            channelId: updated.channelId,
            threadTs: updated.threadTs,
          });
        });
        enqueueResume(resumePromise);
        resumed = true;
      } else {
        logger.warn("Sandbox command webhook cannot resume missing origin thread", {
          id: payload.id,
          channelId: updated.channelId,
          threadTs: updated.threadTs,
        });
      }

      logger.info("Sandbox command webhook processed", {
        id: payload.id,
        status,
        exitCode: payload.exit_code,
        resumed,
      });

      return c.json({ ok: true, resumed });
    } catch (error) {
      recordError("sandbox_command_webhook", error, { id: payload.id });
      return c.json({ error: "Webhook processing failed" }, 500);
    }
  });

  return app;
}
