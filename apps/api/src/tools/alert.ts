import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { logger } from "../lib/logger.js";

/**
 * Sentinel key used by the pipeline to detect alert blocks in tool results.
 * When raise_alert is called, the execute function returns the built Slack
 * alert block under this key so respond.ts can attach it to the current
 * Slack stream (same capture mechanism as TABLE_BLOCK_KEY/CHART_BLOCK_KEY).
 *
 * NOTE (live probe, issue #1246): as of 2026-07-30 Slack rejects `alert`
 * blocks on ALL message surfaces (channels, DMs, chat.appendStream AND
 * chat.postMessage) with `invalid_blocks` ("Unsupported block type: alert").
 * Alert blocks are currently modal-only, per docs.slack.dev. The capture
 * path in respond.ts is wired and tested, but `createAlertTools()` is NOT
 * registered in tools/slack.ts yet — registering it today would break
 * streaming (invalid_blocks is fatal in tryStreamAppend) and silently drop
 * the alert on every call. Flip the one-line registration in slack.ts when
 * Slack enables alert blocks in messages (re-probe first).
 */
export const ALERT_BLOCK_KEY = "__alert_block";

/** Slack's character limit for alert block text. */
const ALERT_TEXT_MAX = 200;

export type AlertLevel = "default" | "info" | "warning" | "error" | "success";

const alertLevelSchema = z.enum(["default", "info", "warning", "error", "success"]);

export function buildAlertBlock(text: string, level?: AlertLevel) {
  return {
    type: "alert" as const,
    text: { type: "mrkdwn" as const, text },
    ...(level ? { level } : {}),
  };
}

export function createAlertTools() {
  return {
    raise_alert: defineTool({
      description:
        "Render a native Slack alert block with visual severity at the bottom of your current reply. " +
        "Use this for escalations that require the recipient to act now — job failures, stale-kill " +
        "notices, heartbeat escalations, security/scam findings — so they can't be confused with a " +
        "routine digest. Do NOT use it for recurring digests or FYI updates; those should stay as " +
        "regular text (or cards via draw_cards).\n\n" +
        "Inputs:\n" +
        "- `text`: short mrkdwn headline, max 200 characters. Put supporting detail in your normal " +
        "message text, not in the alert.\n" +
        "- `level`: severity — `error` for critical failures needing immediate action, `warning` for " +
        "caution/degradation, `info` for notable updates, `success` for confirmations, `default` otherwise.\n\n" +
        "The alert attaches inline to the current reply. Limited to one native block set " +
        "(alert/table/chart/cards) per reply.",
      inputSchema: z.object({
        text: z
          .string()
          .min(1, "Alert text is required")
          .max(ALERT_TEXT_MAX, `Alert text must be ${ALERT_TEXT_MAX} characters or fewer`)
          .describe(
            "The alert headline in mrkdwn (bold, inline code, links supported). Maximum 200 characters. " +
            "Keep it to the single actionable takeaway; put details in the regular message text.",
          ),
        level: alertLevelSchema.describe(
          "Severity level: default, info, warning, error, or success.",
        ),
      }),
      execute: async ({ text, level }) => {
        const trimmed = text.trim();
        if (!trimmed) {
          return { ok: false, error: "Alert text is required." };
        }
        if (trimmed.length > ALERT_TEXT_MAX) {
          return {
            ok: false,
            error: `Alert text is ${trimmed.length} characters; max is ${ALERT_TEXT_MAX}. Move detail into the regular message text.`,
          };
        }

        const alertBlock = buildAlertBlock(trimmed, level);
        logger.info("raise_alert tool called (inline)", {
          level,
          textLength: trimmed.length,
        });
        return { ok: true, [ALERT_BLOCK_KEY]: alertBlock };
      },
      slack: {
        status: "Raising alert...",
        output: (r) => (r.ok !== false ? "Alert rendered" : r.error),
      },
    }),
  };
}
