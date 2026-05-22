import { db } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { jobOutcomes, type JobOutcomeStatus } from "@aura/db/schema";

const MAX_LAST_STEPS = 3;
const MAX_STEP_TEXT_CHARS = 4_000;

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
}): Promise<void> {
  try {
    await db.insert(jobOutcomes).values({
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
    });
  } catch (insertError: any) {
    logger.error("persistJobOutcome: failed to insert outcome row", {
      jobId,
      jobExecutionId,
      outcomeStatus,
      error: insertError?.message,
    });
  }
}
