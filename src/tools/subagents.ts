import { tool } from "ai";
import { z } from "zod";
import type { WebClient } from "@slack/web-api";
import { logger } from "../lib/logger.js";
import { isAdmin } from "../lib/permissions.js";
import { runSubagent } from "../lib/subagent.js";
import { getFastModel, getMainModel } from "../lib/ai.js";
import { createEmailTools, createGmailEATools } from "./email.js";
import { createEmailSyncTools } from "./email-sync.js";
import { createBigQueryTools } from "./bigquery.js";
import { createNoteTools } from "./notes.js";
import type { ScheduleContext } from "../db/schema.js";

// ── Email Triage Subagent ────────────────────────────────────────────────────

const EMAIL_TRIAGE_SYSTEM_PROMPT = `You are Aura's email triage subagent. Your job is to produce a concise, actionable email digest.

Rules:
- Read the user's recent emails (focus on unread and important threads)
- Classify threads by urgency: needs-reply, awaiting-response, FYI, junk
- Produce a structured digest with counts and top items per category
- Highlight anything time-sensitive or from important contacts
- Be concise — this output feeds back into the parent agent's context
- Do NOT send any messages or take any actions — only read and summarize`;

/**
 * Run the email triage subagent.
 * Uses the fast model (Haiku) for cost efficiency with only email-related tools.
 */
export async function runEmailTriageSubagent(
  client: WebClient,
  context: ScheduleContext | undefined,
  userPrompt: string,
): Promise<{ ok: true; digest: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number }; stepCount: number } | { ok: false; error: string }> {
  try {
    const model = await getFastModel();

    const allEmailTools = createEmailTools();
    const allGmailEATools = createGmailEATools();
    const allEmailSyncTools = createEmailSyncTools(client, context);

    const tools = {
      read_emails: allEmailTools.read_emails,
      read_email: allEmailTools.read_email,
      lookup_workspace_user: allEmailTools.lookup_workspace_user,
      list_workspace_users: allEmailTools.list_workspace_users,
      lookup_contact: allEmailTools.lookup_contact,
      check_calendar: allEmailTools.check_calendar,
      find_available_slot: allEmailTools.find_available_slot,
      read_user_emails: allGmailEATools.read_user_emails,
      read_user_email: allGmailEATools.read_user_email,
      list_gmail_drafts: allGmailEATools.list_gmail_drafts,
      email_digest: allEmailSyncTools.email_digest,
    };

    const result = await runSubagent({
      model,
      tools,
      systemPrompt: EMAIL_TRIAGE_SYSTEM_PROMPT,
      userPrompt,
      maxSteps: 50,
    });

    return {
      ok: true,
      digest: result.text,
      usage: result.usage,
      stepCount: result.stepCount,
    };
  } catch (error: any) {
    logger.error("email triage subagent failed", { error: error.message });
    return { ok: false, error: `Email triage subagent failed: ${error.message}` };
  }
}

// ── Bug Investigation Subagent ───────────────────────────────────────────────

const BUG_INVESTIGATION_SYSTEM_PROMPT = `You are Aura's bug investigation subagent. Your job is to investigate a bug report using data tools and produce a findings summary.

Rules:
- Use BigQuery to query production data relevant to the bug
- Check notes for existing knowledge about the affected systems
- Look for patterns: error rates, affected users, timeline of when it started
- Produce a structured findings summary with:
  * What you found (data evidence)
  * Likely root cause (if determinable)
  * Impact assessment (scope, severity)
  * Suggested next steps
- Save important findings to notes for future reference
- Be concise and data-driven — this output feeds back into the parent agent's context
- Do NOT send any messages or take external actions — only investigate and summarize`;

/**
 * Run the bug investigation subagent.
 * Uses the main model for deeper reasoning with BigQuery, note, and list tools.
 */
export async function runBugInvestigationSubagent(
  client: WebClient,
  context: ScheduleContext | undefined,
  userPrompt: string,
): Promise<{ ok: true; findings: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number }; stepCount: number } | { ok: false; error: string }> {
  try {
    const model = await getMainModel();

    const tools = {
      ...createBigQueryTools(context),
      ...createNoteTools(context),
    };

    const result = await runSubagent({
      model,
      tools,
      systemPrompt: BUG_INVESTIGATION_SYSTEM_PROMPT,
      userPrompt,
      maxSteps: 100,
    });

    return {
      ok: true,
      findings: result.text,
      usage: result.usage,
      stepCount: result.stepCount,
    };
  } catch (error: any) {
    logger.error("bug investigation subagent failed", { error: error.message });
    return { ok: false, error: `Bug investigation subagent failed: ${error.message}` };
  }
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

/**
 * Create subagent tools for the AI SDK.
 * These tools delegate focused work to subagents with isolated context windows.
 */
export function createSubagentTools(
  client: WebClient,
  context?: ScheduleContext,
) {
  return {
    run_email_triage: tool({
      description:
        "Delegate email triage to a focused subagent. The subagent reads emails with a scoped set of email tools and returns a structured digest. Uses a fast/cheap model (Haiku) to keep costs low. The subagent has its own isolated context — it won't pollute the parent conversation. Use this for email digests, inbox reviews, and email summaries instead of doing it inline. Admin-only.",
      inputSchema: z.object({
        task: z
          .string()
          .describe(
            "What to triage. Be specific: whose inbox, what time range, what to focus on. E.g. 'Review Joan's unread emails from the last 24 hours, prioritize investor communications'",
          ),
      }),
      execute: async ({ task }) => {
        if (!isAdmin(context?.userId)) {
          return {
            ok: false,
            error: "Only admins can run subagent tasks.",
          };
        }

        const result = await runEmailTriageSubagent(client, context, task);
        if (!result.ok) return result;

        logger.info("run_email_triage tool completed", {
          stepCount: result.stepCount,
          usage: result.usage,
        });

        return {
          ok: true,
          digest: result.digest,
          tokens_used: result.usage.totalTokens,
          steps: result.stepCount,
        };
      },
    }),

    run_bug_investigation: tool({
      description:
        "Delegate a bug investigation to a focused subagent. The subagent queries BigQuery, reads notes, and produces a findings summary. Has its own isolated context window — complex data exploration won't pollute the parent conversation. Use this for data-driven bug investigations, error analysis, and impact assessments. Admin-only.",
      inputSchema: z.object({
        task: z
          .string()
          .describe(
            "What to investigate. Include the bug description, affected systems, and any known details. E.g. 'Users in Switzerland seeing 404 errors on property pages since Feb 20. Check error rates in BigQuery and identify affected properties.'",
          ),
      }),
      execute: async ({ task }) => {
        if (!isAdmin(context?.userId)) {
          return {
            ok: false,
            error: "Only admins can run subagent tasks.",
          };
        }

        const result = await runBugInvestigationSubagent(client, context, task);
        if (!result.ok) return result;

        logger.info("run_bug_investigation tool completed", {
          stepCount: result.stepCount,
          usage: result.usage,
        });

        return {
          ok: true,
          findings: result.findings,
          tokens_used: result.usage.totalTokens,
          steps: result.stepCount,
        };
      },
    }),
  };
}
