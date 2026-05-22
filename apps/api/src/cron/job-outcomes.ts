import { db } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { jobOutcomes, type JobOutcomeStatus } from "@aura/db/schema";

const MAX_TOOL_TRACE_ITEMS = 10;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeJobError(error: unknown, extra?: JsonRecord): JsonRecord {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...extra,
    };
  }

  return {
    message: String(error),
    ...extra,
  };
}

export function extractToolTrace(steps: unknown, maxItems = MAX_TOOL_TRACE_ITEMS): JsonRecord[] {
  if (!Array.isArray(steps)) return [];

  const trace: JsonRecord[] = [];

  steps.forEach((step, stepIndex) => {
    if (!isRecord(step)) return;

    const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
    const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];

    toolCalls.forEach((toolCall, callIndex) => {
      if (!isRecord(toolCall)) return;

      const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : undefined;
      const matchingResult = toolResults.find((result, resultIndex) => {
        if (!isRecord(result)) return false;
        if (toolCallId && result.toolCallId === toolCallId) return true;
        return resultIndex === callIndex;
      });

      trace.push({
        stepIndex,
        toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.input,
        output: isRecord(matchingResult) ? matchingResult.output : undefined,
      });
    });
  });

  return trace.slice(-maxItems);
}

export async function persistJobOutcome({
  workspaceId,
  jobId,
  executionId,
  status,
  output,
  error,
  toolTrace,
}: {
  workspaceId?: string | null;
  jobId: string;
  executionId?: string | null;
  status: JobOutcomeStatus;
  output?: JsonRecord;
  error?: JsonRecord;
  toolTrace?: JsonRecord[];
}): Promise<void> {
  try {
    await db.insert(jobOutcomes).values({
      workspaceId: workspaceId ?? "default",
      jobId,
      executionId: executionId ?? null,
      status,
      output,
      error,
      toolTrace,
    });
  } catch (insertError: any) {
    logger.error("persistJobOutcome: failed to insert outcome row", {
      jobId,
      executionId,
      status,
      error: insertError?.message,
    });
  }
}
