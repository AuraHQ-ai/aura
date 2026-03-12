import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { conversationTraces, conversationMessages, conversationParts, type DetailedTokenUsage } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { computeConversationCost, type StepUsage } from "../lib/cost-calculator.js";

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

interface ReasoningPart {
  type: "reasoning";
  text: string;
  providerMetadata?: Record<string, unknown>;
}

export interface Step {
  text: string;
  reasoning?: ReasoningPart[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  finishReason?: string;
  modelId?: string;
  usage?: DetailedTokenUsage;
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

// ── Create Conversation Trace ────────────────────────────────────────────────

export async function createConversationTrace(params: {
  sourceType: "job_execution" | "interactive";
  jobExecutionId?: string;
  channelId?: string;
  threadTs?: string;
  userId?: string;
  modelId?: string;
}): Promise<string> {
  const [row] = await db
    .insert(conversationTraces)
    .values({
      sourceType: params.sourceType,
      jobExecutionId: params.jobExecutionId ?? null,
      channelId: params.channelId ?? null,
      threadTs: params.threadTs ?? null,
      userId: params.userId ?? null,
      modelId: params.modelId ?? null,
    })
    .returning({ id: conversationTraces.id });

  return row.id;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function insertMessage(
  conversationId: string,
  role: string,
  orderIndex: number,
  parts: PartRow[],
  content?: string | null,
  modelId?: string | null,
  tokenUsage?: DetailedTokenUsage | null,
) {
  const msgId = crypto.randomUUID();

  const msgInsert = db.insert(conversationMessages).values({
    id: msgId,
    conversationId,
    role,
    content: content ?? null,
    orderIndex,
    modelId: modelId ?? null,
    tokenUsage: tokenUsage ?? null,
  });

  if (parts.length === 0) return msgInsert;

  return msgInsert.then(() =>
    db.insert(conversationParts).values(
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

  if (step.reasoning?.length) {
    parts.push({ type: "reasoning", orderIndex: idx++, textValue: step.reasoning.map((r) => r.text).join('\n\n') });
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

/**
 * Map raw AI SDK steps to ConversationStep (Step) objects for persistence.
 */
export function buildConversationSteps(rawSteps: any[]): Step[] {
  return rawSteps.map((step: any) => ({
    text: step.text,
    reasoning: Array.isArray(step.reasoning) ? step.reasoning : undefined,
    toolCalls: step.toolCalls?.map((tc: any) => ({
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: tc.input,
    })),
    toolResults: step.toolResults?.map((tr: any) => ({
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      output: tr.output,
    })),
    finishReason: step.finishReason,
    modelId: step.response?.modelId,
    usage: step.usage ? {
      inputTokens: step.usage.inputTokens ?? 0,
      outputTokens: step.usage.outputTokens ?? 0,
      totalTokens: step.usage.totalTokens ?? 0,
      inputTokenDetails: step.usage.inputTokenDetails,
      outputTokenDetails: step.usage.outputTokenDetails,
    } : undefined,
  }));
}

// ── Phase 1: Persist inputs BEFORE generate ──────────────────────────────────
// Saves system + user messages immediately so they survive crashes.
// Returns the next orderIndex for assistant messages.

export async function persistConversationInputs(
  conversationId: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<number> {
  try {
    await insertMessage(conversationId, "system", 0, [
      { type: "text", orderIndex: 0, textValue: systemPrompt },
    ], systemPrompt);
    await insertMessage(conversationId, "user", 1, [
      { type: "text", orderIndex: 0, textValue: userPrompt },
    ], userPrompt);

    logger.info("persistConversationInputs: saved", { conversationId });
    return 2;
  } catch (err: any) {
    logger.error("persistConversationInputs: failed (non-fatal)", {
      conversationId,
      error: err.message,
    });
    return 2;
  }
}

// ── Phase 2a: Persist assistant steps AFTER generate succeeds ────────────────

export async function persistConversationSteps(
  conversationId: string,
  steps: Step[],
  startOrderIndex: number,
): Promise<void> {
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const parts = stepToParts(step);
      await insertMessage(
        conversationId,
        "assistant",
        startOrderIndex + i,
        parts,
        undefined,
        step.modelId,
        step.usage,
      );
    }

    logger.info("persistConversationSteps: saved", {
      conversationId,
      stepCount: steps.length,
    });
  } catch (err: any) {
    logger.error("persistConversationSteps: failed (non-fatal)", {
      conversationId,
      error: err.message,
    });
  }
}

// ── Phase 2b: Persist error AFTER generate fails ─────────────────────────────

export async function persistConversationError(
  conversationId: string,
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

    await insertMessage(conversationId, "assistant", startOrderIndex, [
      {
        type: "error",
        orderIndex: 0,
        textValue: errorDetail,
      },
    ]);

    logger.info("persistConversationError: saved", { conversationId });
  } catch (err: any) {
    logger.error("persistConversationError: failed (non-fatal)", {
      conversationId,
      error: err.message,
    });
  }
}

// ── Update token usage on a conversation trace ───────────────────────────────

export async function updateConversationTraceUsage(
  conversationId: string,
  tokenUsage: DetailedTokenUsage,
  stepUsages?: StepUsage[],
): Promise<void> {
  try {
    let costUsd: string | null = null;
    if (stepUsages && stepUsages.length > 0) {
      try {
        const cost = await computeConversationCost(stepUsages);
        if (cost > 0) costUsd = cost.toFixed(6);
      } catch (costErr: any) {
        logger.warn("updateConversationTraceUsage: cost computation failed (non-fatal)", {
          conversationId,
          error: costErr.message,
        });
      }
    }

    await db
      .update(conversationTraces)
      .set({
        tokenUsage,
        ...(costUsd != null && { costUsd }),
      })
      .where(eq(conversationTraces.id, conversationId));
  } catch (err: any) {
    logger.error("updateConversationTraceUsage: failed (non-fatal)", {
      conversationId,
      error: err.message,
    });
  }
}
