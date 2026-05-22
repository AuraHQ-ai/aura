import { db } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { jobOutcomes, type JobOutcomeStatus } from "@aura/db/schema";

const MAX_LAST_STEPS = 3;
const MAX_STEP_TEXT_CHARS = 4_000;
const DEFAULT_PUBLIC_URL = "https://aura-alpha-five.vercel.app";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeJobError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function truncateText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= MAX_STEP_TEXT_CHARS) return value;
  return `${value.slice(0, MAX_STEP_TEXT_CHARS)}...`;
}

export function extractLastNSteps(steps: unknown, maxSteps = MAX_LAST_STEPS): JsonRecord[] {
  if (!Array.isArray(steps)) return [];

  const firstStepIndex = steps.length - Math.min(maxSteps, steps.length);

  return steps.slice(-maxSteps).map((step, index) => {
    if (!isRecord(step)) {
      return { index: firstStepIndex + index, value: step };
    }

    return {
      index: firstStepIndex + index,
      finishReason: step.finishReason,
      text: truncateText(step.text),
      toolCalls: Array.isArray(step.toolCalls)
        ? step.toolCalls.map((toolCall) =>
            isRecord(toolCall)
              ? {
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  input: toolCall.input,
                }
              : toolCall,
          )
        : undefined,
      toolResults: Array.isArray(step.toolResults)
        ? step.toolResults.map((toolResult) =>
            isRecord(toolResult)
              ? {
                  toolCallId: toolResult.toolCallId,
                  toolName: toolResult.toolName,
                  output: toolResult.output,
                }
              : toolResult,
          )
        : undefined,
    };
  });
}

export async function persistJobOutcome({
  workspaceId,
  jobId,
  jobExecutionId,
  outcomeStatus,
  output,
  error,
  lastNSteps,
}: {
  workspaceId?: string | null;
  jobId: string;
  jobExecutionId?: string | null;
  outcomeStatus: JobOutcomeStatus;
  output?: JsonRecord;
  error?: string | null;
  lastNSteps?: JsonRecord[];
}): Promise<string | null> {
  try {
    const [outcome] = await db
      .insert(jobOutcomes)
      .values({
        workspaceId: workspaceId ?? "default",
        jobId,
        jobExecutionId: jobExecutionId ?? null,
        outcomeStatus,
        output,
        error,
        lastNSteps,
        supervisorStatus: "pending_review",
        supervisorAttempts: 0,
        updatedAt: new Date(),
      })
      .returning({ id: jobOutcomes.id });

    return outcome?.id ?? null;
  } catch (insertError: unknown) {
    logger.error("persistJobOutcome: failed to insert outcome row", {
      jobId,
      jobExecutionId,
      outcomeStatus,
      error: insertError instanceof Error ? insertError.message : String(insertError),
    });
    return null;
  }
}

function getSupervisorWebhookUrl(): string {
  if (process.env.AURA_PUBLIC_URL) {
    return `${process.env.AURA_PUBLIC_URL.replace(/\/+$/, "")}/api/cron/supervisor`;
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/cron/supervisor`;
  }
  if (process.env.VERCEL_URL) {
    const host = process.env.VERCEL_URL;
    const protocol = host.includes("localhost") ? "http" : "https";
    return `${protocol}://${host}/api/cron/supervisor`;
  }
  return `${DEFAULT_PUBLIC_URL}/api/cron/supervisor`;
}

export function triggerSupervisorReview(outcomeId: string | null | undefined): void {
  if (!outcomeId) return;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    logger.warn("triggerSupervisorReview: CRON_SECRET not configured", { outcomeId });
    return;
  }

  void fetch(getSupervisorWebhookUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ outcomeId }),
    keepalive: true,
  }).catch((error: unknown) => {
    logger.warn("triggerSupervisorReview: supervisor webhook failed", {
      outcomeId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
