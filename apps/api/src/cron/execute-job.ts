import { WebClient } from "@slack/web-api";
import { eq, and, sql, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { jobs, notes, jobExecutions, credentials } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { resolveUserCredentials } from "../lib/permissions.js";
import { sendJobOpsNotice } from "./job-notifications.js";
import { safePostMessage } from "../lib/slack-messaging.js";
import { createHeadlessAgent } from "../lib/agents.js";
import { executionContext } from "../lib/tool.js";
import { getCurrentTimeContext } from "../lib/temporal.js";
import { isJobModelCategory, type JobModelCategory } from "../lib/ai.js";
import { buildStablePrefix, buildTaskPrefix } from "../personality/system-prompt.js";
import {
  createConversationTrace,
  persistConversationInputs,
  persistConversationSteps,
  persistConversationError,
  updateConversationTraceUsage,
  buildConversationSteps,
} from "./persist-conversation.js";
import { detectScriptOutputError } from "./script-output.js";
import { sendJobOpsNotice, truncateJobFailureText } from "./job-notifications.js";
import { buildStepUsages } from "../lib/cost-calculator.js";
import { getScratchpadContents, cleanupScratchpad } from "../tools/scratchpad.js";
import { withTrace } from "../lib/langfuse.js";
import type { DetailedTokenUsage } from "@aura/db/schema";
import {
  extractLastNSteps,
  persistJobOutcome,
  serializeJobError,
  triggerSupervisorReview,
} from "./job-outcomes.js";

const botToken = process.env.SLACK_BOT_TOKEN || "";
const slackClient = new WebClient(botToken);

/** Max retries before marking as failed */
export const MAX_RETRIES = 3;

/** Retry delay in ms (30 minutes — matches heartbeat cron interval) */
const RETRY_DELAY_MS = 30 * 60 * 1000;

type ScriptExecutionOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  detected_error?: string;
};

class ScriptJobError extends Error {
  readonly scriptOutput: ScriptExecutionOutput | null;
  readonly hardFailure: boolean;

  constructor(
    message: string,
    scriptOutput: ScriptExecutionOutput | null,
    hardFailure = false,
  ) {
    super(message);
    this.name = "ScriptJobError";
    this.scriptOutput = scriptOutput;
    this.hardFailure = hardFailure;
  }
}

// ── Script hard-failure detection (issue #961) ───────────────────────────────

/**
 * stderr signatures that mean the script itself is broken (missing file,
 * missing interpreter/module, bad permissions) — retrying the LLM against a
 * playbook cannot recover these and only masks the root cause.
 */
const FATAL_STDERR_PATTERNS: readonly RegExp[] = [
  /No such file or directory/i,
  /command not found/i,
  /ModuleNotFoundError/i,
  /ImportError/i,
  /Permission denied/i,
  /Cannot find module/i,
];

/**
 * True when a script result is a HARD failure that must not fall through to
 * the LLM (issue #961): the script produced nothing usable, so handing the
 * playbook to the model just makes it confabulate a result.
 *
 * Hard = non-zero exit AND (empty/absent stdout, a shell exec-failure exit
 * code 126/127, or stderr matching a known fatal signature). A non-zero exit
 * WITH real stdout is a soft failure — partial output the LLM can work with.
 */
export function isHardFailure(result: {
  exit_code: number | null;
  stdout: string;
  stderr: string;
}): boolean {
  const exitCode = result.exit_code;
  if (exitCode === null || exitCode === 0) return false;
  if (exitCode === 126 || exitCode === 127) return true;
  if (!result.stdout || result.stdout.trim().length === 0) return true;
  return FATAL_STDERR_PATTERNS.some((pattern) => pattern.test(result.stderr));
}

// ── Job-specific additive instructions ───────────────────────────────────────

const JOB_SPECIFIC_INSTRUCTIONS = `## Job execution mode

You are executing a scheduled job autonomously. Additional rules for this mode:
- Execute the task described below using your tools.
- Post results to the specified channel unless the task says otherwise.
- If you have "previous result" context, compare and highlight changes.
- If you discover something urgent, escalate via DM or create a follow-up job.
- Be concise. Digests and summaries, not essays.`;

const CONTINUATION_SPECIFIC_INSTRUCTIONS = `## Continuation mode

You are resuming a multi-step task. Your accumulated progress and context are below. Additional rules for this mode:
- Continue from where you left off. The plan note contains your progress, next steps, and context.
- If you can't finish in this round, use checkpoint_plan again to save progress and schedule another continuation.
- Post results in the thread you're continuing (routing is automatic).
- Be concise and focused. Don't re-explain what was already done -- just continue the work.
- If the continuation depth limit is reached, explain your current status and ask if you should keep going.`;

/**
 * Appended to both injected reply-routing prompts so playbooks that specify
 * silent success are not overridden by a forced "post your results" rule.
 *
 * The second half states the hard NO_OP sentinel contract (issue #1185):
 * silent runs must be declared mechanically via the sentinel, not narrated.
 */
export const SILENT_SUCCESS_CLAUSE =
  " However, if your playbook or task instructions say to stay silent on success, or this run produced no user-facing deliverable, post NOTHING — do not post status updates, receipts, or confirmations that the job ran." +
  " If your playbook says to stay silent on no-op/no-finding runs and this run has nothing to report: make ZERO Slack-posting tool calls (no send_channel_message, send_thread_reply, send_direct_message, draw_table, draw_chart, draw_cards, or upload_file to a channel) and output exactly `NO_OP` (optionally `NO_OP: <one-line reason>`) as your ENTIRE final message. Never post narration like 'Checked X, nothing new' — the `NO_OP` sentinel is how you report a quiet run.";

// ── NO_OP sentinel (hard silent-run contract, issue #1185) ──────────────────

/** Stored in result/lastResult/summary for a clean no-op run. */
export const NO_OP_RESULT_MARKER = "No-op run: nothing to report";

/**
 * Trimmed final text must be exactly `NO_OP`, optionally followed by a
 * one-line reason after a colon (`NO_OP: no new signups today`).
 */
const NO_OP_SENTINEL_RE = /^NO_OP(?::[ \t]*(.*))?$/;

/** Tool calls that always produce user-visible Slack output. */
const SLACK_POSTING_TOOL_NAMES = new Set([
  "send_channel_message",
  "send_thread_reply",
  "send_direct_message",
  "draw_table",
  "draw_chart",
  "draw_cards",
]);

type StepWithToolCalls = {
  toolCalls?: ReadonlyArray<{ toolName: string; input?: unknown }>;
};

/**
 * Detects the NO_OP sentinel in the model's final message. Sentinel-only
 * contract: narration prose ("Checked X, nothing new") is never treated as a
 * no-op declaration.
 */
export function parseNoOpSentinel(
  text: string | null | undefined,
): { reason: string | null } | null {
  const trimmed = (text ?? "").trim();
  const match = trimmed.match(NO_OP_SENTINEL_RE);
  if (!match) return null;
  const reason = (match[1] ?? "").trim();
  return { reason: reason ? reason.slice(0, 200) : null };
}

/**
 * Returns the names of Slack-posting tool calls made during generation.
 * `upload_file` counts when it targets a channel — explicitly via its input,
 * or implicitly through the job's channel (the tool falls back to
 * context.channelId when no channel is passed).
 */
export function findSlackPostingToolCalls(
  steps: ReadonlyArray<StepWithToolCalls>,
  fallbackChannelId?: string | null,
): string[] {
  const postingCalls: string[] = [];
  for (const step of steps) {
    for (const toolCall of step.toolCalls ?? []) {
      if (SLACK_POSTING_TOOL_NAMES.has(toolCall.toolName)) {
        postingCalls.push(toolCall.toolName);
      } else if (toolCall.toolName === "upload_file") {
        const channel = (toolCall.input as { channel?: unknown } | null | undefined)?.channel;
        const targetsChannel =
          (typeof channel === "string" && channel.length > 0) || !!fallbackChannelId;
        if (targetsChannel) postingCalls.push(toolCall.toolName);
      }
    }
  }
  return postingCalls;
}

// ── Continuation Detection ───────────────────────────────────────────────────

const CONTINUE_TAG_RE = /^\[CONTINUE:([^\]]+)\]\s*/;

/**
 * Optional depth suffix on the tag topic (issue #1320):
 * `[CONTINUE:turn-deadline-abc123:d2]` → topic `turn-deadline-abc123`,
 * depth 2. Tags without the suffix (checkpoint_plan, legacy jobs) are
 * depth 1 — they ARE continuations, just the first in their chain.
 */
const CONTINUATION_DEPTH_RE = /^(.+):d(\d+)$/;

export interface ContinuationTag {
  topic: string;
  depth: number;
}

export function parseContinuationTag(description: string): ContinuationTag | null {
  const match = description.match(CONTINUE_TAG_RE);
  if (!match) return null;
  const depthMatch = match[1].match(CONTINUATION_DEPTH_RE);
  if (depthMatch) {
    return { topic: depthMatch[1], depth: Math.max(1, Number(depthMatch[2])) };
  }
  return { topic: match[1], depth: 1 };
}

async function loadPlanNote(topic: string): Promise<string | null> {
  const rows = await db
    .select({ content: notes.content })
    .from(notes)
    .where(eq(notes.topic, topic))
    .limit(1);
  return rows[0]?.content ?? null;
}

// ── Required-credential availability (issue #1344) ──────────────────────────

export interface MissingJobCredential {
  id: string;
  name: string | null;
  scope: string | null;
  ownerId: string | null;
  reason: "not_found" | "not_accessible";
}

/**
 * Resolve which of a job's required credentials are NOT available to the job
 * owner (job.requestedBy).
 *
 * Sandbox envs and typed tools are deliberately caller-scoped to the job
 * owner (see getSandboxEnvs), so a job that requires a credential its owner
 * can't access — e.g. an admin-scoped credential on a job owned by a
 * non-admin — would otherwise run with a silently incomplete env. executeJob
 * uses this to make that loss explicit: it fails the run before doing any
 * work instead of proceeding. Detection only — never widens anyone's scope.
 */
export async function findMissingJobCredentials(
  requiredCredentialIds: string[],
  jobOwnerId: string,
): Promise<MissingJobCredential[]> {
  const uniqueIds = [...new Set(requiredCredentialIds)];
  if (uniqueIds.length === 0) return [];

  const rows = await db
    .select({
      id: credentials.id,
      name: credentials.name,
      scope: credentials.scope,
      ownerId: credentials.ownerId,
    })
    .from(credentials)
    .where(inArray(credentials.id, uniqueIds));
  const rowById = new Map(rows.map((row) => [row.id, row]));

  // Pin credential resolution to the job owner: when a job is dispatched from
  // an interactive turn, the ambient execution context would otherwise leak
  // the dispatcher's identity into resolveUserCredentials.
  const accessibleNames = await executionContext.run(
    {
      triggeredBy: jobOwnerId,
      triggerType: "scheduled_job",
      callingUserId: jobOwnerId,
    },
    () => resolveUserCredentials(jobOwnerId),
  );

  const missing: MissingJobCredential[] = [];
  for (const id of uniqueIds) {
    const row = rowById.get(id);
    if (!row) {
      missing.push({ id, name: null, scope: null, ownerId: null, reason: "not_found" });
    } else if (!accessibleNames.has(row.name)) {
      missing.push({ ...row, reason: "not_accessible" });
    }
  }
  return missing;
}

/** Human-readable, actionable description of one missing job credential. */
export function describeMissingJobCredential(cred: MissingJobCredential): string {
  if (cred.reason === "not_found") {
    return `credential ${cred.id} no longer exists (deleted?)`;
  }
  const scopePart = cred.scope ? `scope ${cred.scope}` : "unknown scope";
  const ownerPart = cred.ownerId ? `, owned by ${cred.ownerId}` : "";
  return `"${cred.name}" (${cred.id}, ${scopePart}${ownerPart})`;
}

// ── Job Execution ────────────────────────────────────────────────────────────

/**
 * Trigger semantics (issue #1238):
 * - "heartbeat":    a genuine ON-SCHEDULE cron/frequency fire. The ONLY trigger
 *                   that consumes the minIntervalHours/cooldownHours budget in
 *                   isRecurringJobDue().
 * - "dispatch":     manual/immediate run (dispatch_headless tool, /api/execute-now).
 * - "continuation": plan-note continuation resume.
 * - "recovery":     off-schedule requeue (supervisor retry_as_is/retry_with_fix,
 *                   stale-running recovery). Runs like a heartbeat fire but must
 *                   NOT reset the frequency-gate interval clock.
 */
export async function executeJob(
  job: typeof jobs.$inferSelect,
  trigger: "heartbeat" | "dispatch" | "continuation" | "recovery" = "heartbeat",
): Promise<boolean> {
  const jobId = job.id;

  // Tracks next message order_index; set by persistConversationInputs,
  // used by error handler if generate throws.
  let conversationOrderIndex = 0;
  let conversationId: string | undefined;
  let executionId: string | null = null;
  const invocationId = crypto.randomUUID();
  let lastNSteps: Array<Record<string, unknown>> = [];
  let scriptExecutionOutput: ScriptExecutionOutput | null = null;

  try {
    // Atomically claim the job to prevent duplicate execution.
    // If another process already claimed it, this updates 0 rows.
    // suspendedUntil is reset so a leftover webhook-suspension shield from a
    // previous run (issue #1326) never protects this fresh run.
    const claimed = await db
      .update(jobs)
      .set({ status: "running", suspendedUntil: null, updatedAt: new Date() })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "pending"), eq(jobs.enabled, 1)))
      .returning({ id: jobs.id });

    if (claimed.length === 0) {
      logger.info("executeJob: job already claimed or disabled, skipping", { jobId, jobName: job.name });
      return false;
    }

    // Insert execution trace row.
    const [execution] = await db
      .insert(jobExecutions)
      .values({
        workspaceId: job.workspaceId,
        jobId,
        status: "running",
        trigger,
        callbackChannel: job.channelId || null,
        callbackThreadTs: job.threadTs || null,
      })
      .returning({ id: jobExecutions.id });

    executionId = execution.id;
    if (!executionId) {
      throw new Error("Failed to create job execution trace");
    }

    const continuationTag = parseContinuationTag(job.description);
    const isContinuation = continuationTag !== null;
    const isRecurring = !!job.cronSchedule || !!job.frequencyConfig;

    const effectiveTrigger = isContinuation && trigger === "heartbeat" ? "continuation" : trigger;
    if (effectiveTrigger !== trigger) {
      await db
        .update(jobExecutions)
        .set({ trigger: effectiveTrigger })
        .where(eq(jobExecutions.id, executionId));
    }

    let prompt: string;
    let systemPrompt: string;

    const credentialIds = job.requiredCredentialIds ?? [];

    // Fail closed when a required credential is not available to the job
    // owner (issue #1344). Credential resolution is deliberately scoped to
    // job.requestedBy; running anyway would silently drop the credential.
    if (credentialIds.length > 0) {
      const missingCredentials = await findMissingJobCredentials(
        credentialIds,
        job.requestedBy,
      );
      if (missingCredentials.length > 0) {
        const detail = missingCredentials
          .map(describeMissingJobCredential)
          .join("; ");
        const message =
          `Required credential(s) not available to job owner ${job.requestedBy}: ${detail}. ` +
          `Credential resolution is deliberately scoped to the job owner, so the run was ` +
          `aborted instead of executing with a silently incomplete credential set. ` +
          `Fix: grant the credential to ${job.requestedBy}, or transfer the job to a user ` +
          `with access. Credential scope was NOT widened.`;
        await sendJobOpsNotice({
          jobId,
          jobName: job.name,
          requestedBy: job.requestedBy,
          text: `:no_entry: ${message}`,
          logContext: { missingCredentials },
        });
        throw new Error(message);
      }
    }

    const credentialNote =
      credentialIds.length > 0
        ? `\n\nAuthorized credential IDs for this job: ${credentialIds.join(", ")}`
        : "";

    // Scoped execution (issue #1302): prompt_mode 'task' skips the full
    // personality prefix; model routes to a catalog category; env_allowlist
    // narrows the sandbox env (applied below via executionContext + script layer).
    // Jobs default to 'medium' (Sonnet-class); frontier 'main' is opt-in.
    const isTaskMode = job.promptMode === "task";
    const modelCategory: JobModelCategory = isJobModelCategory(job.model)
      ? job.model
      : "medium";
    const envAllowlist = job.envAllowlist ?? undefined;

    const stablePrefix = isTaskMode ? buildTaskPrefix() : await buildStablePrefix();
    const timeContext = getCurrentTimeContext(job.timezone);

    if (continuationTag) {
      const planContent = await loadPlanNote(continuationTag.topic);
      const nextSteps = job.description.replace(CONTINUE_TAG_RE, "");

      prompt = planContent
        ? `Plan note "${continuationTag.topic}":\n\n${planContent}\n\nNext steps to execute:\n${nextSteps}${credentialNote}`
        : `Plan note "${continuationTag.topic}" not found. Original instructions:\n${nextSteps}${credentialNote}`;

      systemPrompt = stablePrefix + "\n\n" + timeContext + "\n\n" + CONTINUATION_SPECIFIC_INSTRUCTIONS;

      logger.info("Heartbeat: executing continuation", {
        jobId,
        executionId,
        planTopic: continuationTag.topic,
        continuationDepth: continuationTag.depth,
        hasPlanNote: !!planContent,
        credentialCount: credentialIds.length,
      });
    } else {
      prompt = job.playbook
        ? `Job: ${job.name}\nDescription: ${job.description}\n\nPlaybook:\n${job.playbook}${credentialNote}`
        : `${job.description}${credentialNote}`;

      if (job.lastResult) {
        prompt += `\n\nPrevious result for context:\n${job.lastResult}`;
      }

      systemPrompt = stablePrefix + "\n\n" + timeContext + "\n\n" + JOB_SPECIFIC_INSTRUCTIONS;

      logger.info("Heartbeat: executing job", {
        jobId,
        executionId,
        jobName: job.name,
        isRecurring,
        hasPlaybook: !!job.playbook,
        trigger: effectiveTrigger,
        credentialCount: credentialIds.length,
        modelCategory,
        promptMode: isTaskMode ? "task" : "full",
        envAllowlistSize: envAllowlist?.length ?? null,
      });
    }

    // Inject reply-routing so the agent posts results back to the originating thread/channel
    if (job.channelId && job.threadTs) {
      prompt += `\n\nIMPORTANT: Post your results using send_thread_reply(channel="${job.channelId}", thread_ts="${job.threadTs}"). If your response is too long for one message, post the first part with send_thread_reply, then post each continuation ALSO with send_thread_reply(channel="${job.channelId}", thread_ts="${job.threadTs}") — all parts in the same thread. Do NOT call send_direct_message.${SILENT_SUCCESS_CLAUSE}`;
    } else if (job.channelId) {
      prompt += `\n\nIMPORTANT: Post your results to channel "${job.channelId}" using send_channel_message. Do NOT use send_direct_message.${SILENT_SUCCESS_CLAUSE}`;
    }

    // ── Script execution layer ──────────────────────────────────────────────
    let scriptOutput: string | null = null;
    // Set on a SOFT script failure that falls through to the LLM so the model
    // sees what actually happened instead of confabulating (issue #961).
    let scriptFailureContext: string | null = null;

    if (job.script) {
      try {
        const { getOrCreateSandbox, truncateOutput, getSandboxEnvs, filterEnvsByAllowlist } =
          await import("../lib/sandbox.js");
        // Use the job requester's sandbox so the script layer shares state
        // (checkouts, installed deps) with the job's LLM run_command calls.
        const sandbox = await getOrCreateSandbox(job.requestedBy);
        // Script layer runs outside executionContext.run, so apply the job's
        // env allowlist explicitly here (narrows, never widens).
        const envs = filterEnvsByAllowlist(
          await getSandboxEnvs(job.requestedBy),
          envAllowlist ?? null,
        );

        const scriptResult = await sandbox.commands.run(job.script, {
          timeoutMs: 120_000,
          cwd: "/home/user",
          envs,
        });

        const exitCode = scriptResult.exitCode;
        const stdout = scriptResult.stdout || "";
        const stderr = scriptResult.stderr || "";
        const truncatedStdout = truncateOutput(stdout, 50_000);
        const truncatedStderr = truncateOutput(stderr, 50_000);

        scriptExecutionOutput = {
          stdout: truncatedStdout,
          stderr: truncatedStderr,
          exit_code: exitCode,
        };

        if (exitCode !== 0) {
          const outputTail = (stderr || stdout).slice(-2000);

          // Hard failure (issue #961): the script produced nothing usable —
          // never hand the playbook to the LLM, it would only confabulate.
          // The catch below sends the ops notice and rethrows into the
          // normal retry/escalation path.
          if (isHardFailure(scriptExecutionOutput)) {
            throw new ScriptJobError(
              `Script hard failure (exit code ${exitCode}):\n${outputTail}`,
              scriptExecutionOutput,
              true,
            );
          }

          if (job.playbook) {
            logger.warn("executeJob: script soft-failed, falling through to LLM", {
              jobId,
              jobName: job.name,
              exitCode,
              stderr: stderr.slice(0, 500),
            });
            scriptFailureContext =
              `Script exited with code ${exitCode}.\n\n` +
              `stderr tail:\n${truncatedStderr.slice(-2000)}\n\n` +
              `stdout tail:\n${truncatedStdout.slice(-2000)}`;
          } else {
            throw new ScriptJobError(
              `Script exited with code ${exitCode}:\n${outputTail}`,
              scriptExecutionOutput,
            );
          }
        } else {
          scriptOutput = truncatedStdout;

          const outputError = detectScriptOutputError(stdout);
          if (outputError) {
            scriptExecutionOutput.detected_error = outputError;
          }

          if (outputError && !job.playbook) {
            const outputTail = stdout.slice(-2000);
            throw new ScriptJobError(
              `Script reported error: ${outputError}\n${outputTail}`,
              scriptExecutionOutput,
            );
          }

          if (!job.playbook) {
            const resultText = scriptOutput || "(script produced no output)";

            if (job.channelId && job.threadTs) {
              await safePostMessage(slackClient, {
                channel: job.channelId,
                thread_ts: job.threadTs,
                text: resultText,
              });
            } else if (job.channelId) {
              await safePostMessage(slackClient, {
                channel: job.channelId,
                text: resultText,
              });
            }

            const now = new Date();
            const todayStr = now.toISOString().slice(0, 10);
            const isNewDay = job.lastExecutionDate !== todayStr;

            await db.update(jobs).set({
              status: isRecurring ? "pending" : "completed",
              ...(isRecurring ? { executeAt: null } : {}),
              result: resultText.slice(0, 2000),
              lastResult: resultText.slice(0, 2000),
              lastExecutedAt: now,
              executionCount: sql`${jobs.executionCount} + 1`,
              todayExecutions: isNewDay ? 1 : sql`${jobs.todayExecutions} + 1`,
              lastExecutionDate: todayStr,
              retries: 0,
              updatedAt: now,
            }).where(eq(jobs.id, jobId));

            await db.update(jobExecutions).set({
              status: "completed",
              finishedAt: now,
              summary: resultText.slice(0, 500),
            }).where(eq(jobExecutions.id, executionId));

            const outcomeId = await persistJobOutcome({
              workspaceId: job.workspaceId,
              jobId,
              jobExecutionId: executionId,
              outcomeStatus: "succeeded",
              output: {
                type: "script",
                script: scriptExecutionOutput ?? {
                  stdout: scriptOutput ?? "",
                  stderr: "",
                  exit_code: 0,
                },
              },
              lastNSteps: [],
            });
            triggerSupervisorReview(outcomeId);

            logger.info("executeJob: script-only job completed", { jobId, jobName: job.name });
            return true;
          }

          if (outputError) {
            logger.warn("executeJob: script output contains error JSON, falling through to LLM", {
              jobId,
              jobName: job.name,
              outputError,
            });
          }
        }
      } catch (scriptErr: any) {
        if (scriptOutput) {
          throw scriptErr;
        }

        // Thrown execution errors (e.g. the sandbox SDK's CommandExitError)
        // carry exitCode/stdout/stderr — snapshot them so they get the same
        // hard-failure classification as returned results (issue #961).
        if (!scriptExecutionOutput && typeof scriptErr?.exitCode === "number") {
          scriptExecutionOutput = {
            stdout: String(scriptErr.stdout ?? ""),
            stderr: String(scriptErr.stderr ?? scriptErr.message ?? ""),
            exit_code: scriptErr.exitCode,
          };
        }

        const hardFailure =
          scriptErr instanceof ScriptJobError
            ? scriptErr.hardFailure
            : scriptExecutionOutput !== null && isHardFailure(scriptExecutionOutput);

        if (hardFailure) {
          // Issue #961: surface the hard failure to ops, then rethrow into
          // the outer catch so the execution is marked failed with the real
          // stderr and the normal retry/escalation path takes over. The LLM
          // is never invoked for this run.
          const stderrTail = truncateJobFailureText(
            scriptExecutionOutput?.stderr ||
              scriptExecutionOutput?.stdout ||
              scriptErr?.message,
          );
          await sendJobOpsNotice({
            jobId,
            jobName: job.name,
            requestedBy: job.requestedBy,
            text:
              `:x: Script hard failure (exit code ${scriptExecutionOutput?.exit_code ?? "unknown"}) — ` +
              `execution marked failed, LLM not invoked.\n\`\`\`${stderrTail}\`\`\``,
            logContext: { event: "script_hard_failure", executionId },
          });
          throw scriptErr instanceof ScriptJobError
            ? scriptErr
            : new ScriptJobError(
                scriptErr?.message ?? String(scriptErr),
                scriptExecutionOutput,
                true,
              );
        }

        if (!job.playbook) {
          throw scriptErr instanceof ScriptJobError
            ? scriptErr
            : new ScriptJobError(scriptErr?.message ?? String(scriptErr), scriptExecutionOutput);
        }
        logger.warn("executeJob: script execution error, falling through to LLM", {
          jobId,
          jobName: job.name,
          error: scriptErr.message,
        });
        scriptFailureContext ??= `Script execution error: ${
          scriptErr?.message ?? String(scriptErr)
        }`;
      }
    }

    if (scriptOutput) {
      prompt = `## Pre-computed data (from script)\n\n\`\`\`json\n${scriptOutput}\n\`\`\`\n\n---\n\n${prompt}`;
    } else if (scriptFailureContext) {
      prompt =
        `## Script layer soft failure\n\nThe job's script failed before this step. ` +
        `Diagnose or recover using your playbook and the output below — do NOT invent data the script did not produce.\n\n` +
        `${scriptFailureContext}\n\n---\n\n${prompt}`;
    }

    // Job-scoped execution context, active during BOTH agent/tool
    // construction and generation. Building the tool set inside it means
    // credential-gated typed tools are filtered against the job's env
    // allowlist (issue #1312) and credential resolution is pinned to the job
    // owner rather than any ambient dispatcher context.
    const jobExecutionContext = {
      triggeredBy: job.requestedBy,
      triggerType: "scheduled_job" as const,
      callingUserId: job.requestedBy,
      jobId: job.id,
      envAllowlist,
      jobExecutionId: executionId,
    };

    const { agent, modelId, getStepModelIds, getCompactionTotals } =
      await executionContext.run(jobExecutionContext, () =>
        createHeadlessAgent({
          slackClient,
          context: {
            userId: job.requestedBy,
            channelId: job.channelId || undefined,
            threadTs: job.threadTs || undefined,
          },
          systemPrompt,
          invocationId,
          modelCategory,
          // Depth of the chain this job belongs to (issue #1320): a hard-deadline
          // respawn from inside this run continues at depth + 1, capped at 3.
          continuationDepth: continuationTag?.depth ?? 0,
        }),
      );

    // Create a conversation trace for this job execution
    conversationId = await createConversationTrace({
      sourceType: "job_execution",
      jobExecutionId: executionId,
      modelId,
    });

    // Phase 1: persist the exact inputs BEFORE calling generate.
    // If the process crashes mid-execution, we still have what was sent.
    conversationOrderIndex = await persistConversationInputs(
      conversationId,
      systemPrompt,
      prompt,
    );

    const generateResult = await executionContext.run(
      jobExecutionContext,
      () =>
        withTrace(
          {
            traceName: "headless-job",
            sessionId: job.threadTs || job.channelId || job.id,
            userId: job.requestedBy,
            tags: [
              "channel:scheduled-job",
              ...(job.channelId ? [`slack-channel:${job.channelId}`] : []),
            ],
            metadata: { slackUserId: job.requestedBy, jobId: job.id },
          },
          () => agent.generate({ prompt }),
        ),
    );

    const { text, steps, totalUsage: usage } = generateResult;

    // NO_OP sentinel contract (issue #1185): a clean no-op (sentinel + zero
    // Slack-posting tool calls) completes normally but records an honest
    // marker instead of narration. Sentinel + Slack posts is a contract
    // violation: log it so it's measurable; never suppress or delete posts.
    const noOpSentinel = parseNoOpSentinel(text);
    let isCleanNoOp = false;
    if (noOpSentinel) {
      const postingToolCalls = findSlackPostingToolCalls(steps, job.channelId);
      isCleanNoOp = postingToolCalls.length === 0;
      if (!isCleanNoOp) {
        logger.warn(
          "executeJob: NO_OP sentinel contract violation — model posted to Slack and declared NO_OP",
          {
            jobId,
            executionId,
            jobName: job.name,
            postingToolCalls,
          },
        );
      }
    }
    const noOpMarker = noOpSentinel?.reason
      ? `${NO_OP_RESULT_MARKER} (${noOpSentinel.reason})`
      : NO_OP_RESULT_MARKER;

    // Phase 2a: persist assistant steps now that generate succeeded
    const stepModelIds = getStepModelIds();
    const conversationSteps = buildConversationSteps(steps, stepModelIds, modelId);
    await persistConversationSteps(conversationId, conversationSteps, conversationOrderIndex);

    const serializedSteps = steps.map((step) => ({
      type: step.finishReason,
      text: step.text,
      toolCalls: step.toolCalls?.map((tc) => ({
        toolName: tc.toolName,
        input: tc.input,
      })),
      toolResults: step.toolResults?.map((tr) => ({
        toolName: tr.toolName,
        output: tr.output,
      })),
    }));
    lastNSteps = extractLastNSteps(steps);

    const tokenUsage: DetailedTokenUsage = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      inputTokenDetails: usage.inputTokenDetails,
      outputTokenDetails: usage.outputTokenDetails,
    };

    const stepUsages = buildStepUsages(steps, stepModelIds, modelId);

    // Update trace with token usage + cost + per-turn compaction totals
    await updateConversationTraceUsage(
      conversationId,
      tokenUsage,
      stepUsages,
      getCompactionTotals?.(),
    );

    // Persist scratchpad contents for debugging
    const scratchpadContents = getScratchpadContents(invocationId);
    if (scratchpadContents) {
      logger.info("Job scratchpad contents", {
        executionId,
        sections: Object.keys(scratchpadContents),
      });
    }

    // Update execution trace with results (include scratchpad in the steps jsonb)
    await db
      .update(jobExecutions)
      .set({
        status: "completed",
        finishedAt: new Date(),
        steps: scratchpadContents
          ? { steps: serializedSteps, scratchpad: scratchpadContents }
          : serializedSteps,
        tokenUsage,
        summary: isCleanNoOp ? noOpMarker.substring(0, 500) : (text || "").substring(0, 500) || null,
      })
      .where(eq(jobExecutions.id, executionId));

    const result = (
      isCleanNoOp ? noOpMarker : text || "Job completed (no text output)"
    ).substring(0, 2000);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const isNewDay = job.lastExecutionDate !== todayStr;

    if (isRecurring) {
      await db
        .update(jobs)
        .set({
          status: "pending",
          executeAt: null,
          retries: 0,
          lastExecutedAt: now,
          executionCount: sql`${jobs.executionCount} + 1`,
          todayExecutions: isNewDay ? 1 : sql`${jobs.todayExecutions} + 1`,
          lastExecutionDate: todayStr,
          lastResult: result,
          updatedAt: now,
        })
        .where(eq(jobs.id, jobId));

      logger.info("Heartbeat: recurring job completed", {
        jobName: job.name,
        executionId,
      });
    } else {
      await db
        .update(jobs)
        .set({
          status: "completed",
          result,
          lastExecutedAt: now,
          executionCount: sql`${jobs.executionCount} + 1`,
          updatedAt: now,
        })
        .where(eq(jobs.id, jobId));

      logger.info("Heartbeat: one-shot job completed", {
        jobName: job.name,
        executionId,
        isContinuation,
      });
    }

    const outcomeId = await persistJobOutcome({
      workspaceId: job.workspaceId,
      jobId,
      jobExecutionId: executionId,
      outcomeStatus: "succeeded",
      output: {
        type: "llm",
        final_message: text || null,
        ...(isCleanNoOp
          ? {
              no_op: true,
              ...(noOpSentinel?.reason ? { no_op_reason: noOpSentinel.reason } : {}),
            }
          : {}),
        ...(noOpSentinel && !isCleanNoOp ? { no_op_violation: true } : {}),
        scratchpad: scratchpadContents ?? null,
        ...(scriptExecutionOutput ? { script: scriptExecutionOutput } : {}),
      },
      lastNSteps,
    });
    triggerSupervisorReview(outcomeId);

    return true;
  } catch (error: any) {
    // Persist the error in conversation history regardless of error type
    if (conversationId) {
      await persistConversationError(conversationId, error, conversationOrderIndex);
    }

    // Update execution trace with failure (protected so it can't break retry logic)
    if (executionId) {
      try {
        await db
          .update(jobExecutions)
          .set({
            status: "failed",
            finishedAt: new Date(),
            error: error.message,
          })
          .where(eq(jobExecutions.id, executionId));
      } catch (traceErr: any) {
        logger.error("executeJob: failed to update execution trace", {
          jobId,
          executionId,
          error: traceErr.message,
        });
      }
    }

    // Retry logic
    const newRetries = job.retries + 1;
    const retryExhausted = newRetries >= MAX_RETRIES;
    const scratchpadContents = getScratchpadContents(invocationId);

    const outcomeId = await persistJobOutcome({
      workspaceId: job.workspaceId,
      jobId,
      jobExecutionId: executionId,
      outcomeStatus: "errored",
      output: {
        ...(scriptExecutionOutput ? { script: scriptExecutionOutput } : {}),
        ...(scratchpadContents ? { scratchpad: scratchpadContents } : {}),
        retries: newRetries,
        retry_exhausted: retryExhausted,
      },
      error: serializeJobError(error),
      lastNSteps,
    });
    triggerSupervisorReview(outcomeId);

    if (!executionId) {
      throw error;
    }

    if (newRetries < MAX_RETRIES) {
      const retryAt = new Date(Date.now() + RETRY_DELAY_MS);
      await db
        .update(jobs)
        .set({ status: "pending", executeAt: retryAt, retries: newRetries, updatedAt: new Date() })
        .where(eq(jobs.id, jobId));

      logger.warn("Heartbeat: job retrying", {
        jobName: job.name,
        executionId,
        retries: newRetries,
        retryAt: retryAt.toISOString(),
      });
    } else {
      await db
        .update(jobs)
        .set({
          status: "failed",
          result: `Failed after ${MAX_RETRIES} retries: ${error.message}`,
          retries: newRetries,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));

      logger.error("Heartbeat: job failed permanently", {
        jobName: job.name,
        executionId,
        error: error.message,
      });
    }

    throw error;
  } finally {
    cleanupScratchpad(invocationId);
  }
}
