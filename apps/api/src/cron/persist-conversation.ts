import { db } from "../db/client.js";
import { jobExecutionMessages, jobExecutionParts } from "@aura/db/schema";
import { logger } from "../lib/logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface ToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

interface ToolResult {
  toolCallId: string;
  toolName: string;
  output: unknown;
}

export interface Step {
  text: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  finishReason?: string;
}

type PartRow = {
  type: string;
  orderIndex: number;
  textValue?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolState?: string | null;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function insertMessage(
  executionId: string,
  role: string,
  orderIndex: number,
  parts: PartRow[],
) {
  const msgId = crypto.randomUUID();

  const msgInsert = db.insert(jobExecutionMessages).values({
    id: msgId,
    executionId,
    role,
    orderIndex,
  });

  if (parts.length === 0) return msgInsert;

  return msgInsert.then(() =>
    db.insert(jobExecutionParts).values(
      parts.map((p) => ({
        messageId: msgId,
        type: p.type,
        orderIndex: p.orderIndex,
        textValue: p.textValue ?? null,
        toolCallId: p.toolCallId ?? null,
        toolName: p.toolName ?? null,
        toolInput: p.toolInput ?? null,
        toolOutput: p.toolOutput ?? null,
        toolState: p.toolState ?? null,
      })),
    ),
  );
}

function stepToParts(step: Step): PartRow[] {
  const parts: PartRow[] = [];
  let idx = 0;

  parts.push({ type: "step-start", orderIndex: idx++ });

  if (step.reasoning) {
    parts.push({ type: "reasoning", orderIndex: idx++, textValue: step.reasoning });
  }

  if (step.toolCalls && step.toolCalls.length > 0) {
    for (const tc of step.toolCalls) {
      const tr = step.toolResults?.find((r) => r.toolCallId === tc.toolCallId);
      parts.push({
        type: "tool-invocation",
        orderIndex: idx++,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        toolInput: tc.input,
        toolOutput: tr?.output ?? null,
        toolState: tr ? "result" : "call",
      });
    }
  }

  if (step.text) {
    parts.push({ type: "text", orderIndex: idx++, textValue: step.text });
  }

  return parts;
}

// ── Phase 1: Persist inputs BEFORE generate ──────────────────────────────────
// Saves system + user messages immediately so they survive crashes.
// Returns the next orderIndex for assistant messages.

export async function persistConversationInputs(
  executionId: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<number> {
  try {
    await insertMessage(executionId, "system", 0, [
      { type: "text", orderIndex: 0, textValue: systemPrompt },
    ]);
    await insertMessage(executionId, "user", 1, [
      { type: "text", orderIndex: 0, textValue: userPrompt },
    ]);

    logger.info("persistConversationInputs: saved", { executionId });
    return 2;
  } catch (err: any) {
    logger.error("persistConversationInputs: failed (non-fatal)", {
      executionId,
      error: err.message,
    });
    return 2;
  }
}

// ── Phase 2a: Persist assistant steps AFTER generate succeeds ────────────────

export async function persistConversationSteps(
  executionId: string,
  steps: Step[],
  startOrderIndex: number,
): Promise<void> {
  try {
    for (let i = 0; i < steps.length; i++) {
      const parts = stepToParts(steps[i]);
      await insertMessage(executionId, "assistant", startOrderIndex + i, parts);
    }

    logger.info("persistConversationSteps: saved", {
      executionId,
      stepCount: steps.length,
    });
  } catch (err: any) {
    logger.error("persistConversationSteps: failed (non-fatal)", {
      executionId,
      error: err.message,
    });
  }
}

// ── Phase 2b: Persist error AFTER generate fails ─────────────────────────────
// Saves whatever we know: the error message and optionally any partial steps
// that were available on the error object.

export async function persistConversationError(
  executionId: string,
  error: Error,
  startOrderIndex: number,
): Promise<void> {
  try {
    const errorDetail = [
      error.message,
      error.name !== "Error" ? `(${error.name})` : "",
      error.stack ? `\n\nStack:\n${error.stack}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    await insertMessage(executionId, "assistant", startOrderIndex, [
      {
        type: "error",
        orderIndex: 0,
        textValue: errorDetail,
      },
    ]);

    logger.info("persistConversationError: saved", { executionId });
  } catch (err: any) {
    logger.error("persistConversationError: failed (non-fatal)", {
      executionId,
      error: err.message,
    });
  }
}
