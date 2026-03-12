import { db } from "../db/client.js";
import { jobExecutionMessages, jobExecutionParts } from "@aura/db/schema";
import { logger } from "../lib/logger.js";

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

interface Step {
  text: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  finishReason?: string;
}

export interface ConversationData {
  systemPrompt: string;
  userPrompt: string;
  steps: Step[];
}

/**
 * Persist the full LLM conversation (system prompt, user prompt, and all
 * assistant steps with reasoning/tool calls/text) into the
 * job_execution_messages + job_execution_parts tables.
 *
 * This stores the EXACT bytes that went into generateText() so we can
 * reconstruct the full API call for debugging.
 */
export async function persistExecutionConversation(
  executionId: string,
  data: ConversationData,
): Promise<void> {
  try {
    const messageRows: {
      id: string;
      role: string;
      orderIndex: number;
      parts: Array<{
        type: string;
        orderIndex: number;
        textValue?: string | null;
        toolCallId?: string | null;
        toolName?: string | null;
        toolInput?: unknown;
        toolOutput?: unknown;
        toolState?: string | null;
      }>;
    }[] = [];

    let msgIdx = 0;

    // 1. System message — the exact system prompt string
    messageRows.push({
      id: crypto.randomUUID(),
      role: "system",
      orderIndex: msgIdx++,
      parts: [
        {
          type: "text",
          orderIndex: 0,
          textValue: data.systemPrompt,
        },
      ],
    });

    // 2. User message — the exact user prompt string
    messageRows.push({
      id: crypto.randomUUID(),
      role: "user",
      orderIndex: msgIdx++,
      parts: [
        {
          type: "text",
          orderIndex: 0,
          textValue: data.userPrompt,
        },
      ],
    });

    // 3. Assistant messages — one per step
    for (const step of data.steps) {
      const parts: typeof messageRows[0]["parts"] = [];
      let partIdx = 0;

      parts.push({
        type: "step-start",
        orderIndex: partIdx++,
      });

      if (step.reasoning) {
        parts.push({
          type: "reasoning",
          orderIndex: partIdx++,
          textValue: step.reasoning,
        });
      }

      if (step.toolCalls && step.toolCalls.length > 0) {
        for (const tc of step.toolCalls) {
          const tr = step.toolResults?.find(
            (r) => r.toolCallId === tc.toolCallId,
          );

          parts.push({
            type: "tool-invocation",
            orderIndex: partIdx++,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            toolInput: tc.input,
            toolOutput: tr?.output ?? null,
            toolState: tr ? "result" : "call",
          });
        }
      }

      if (step.text) {
        parts.push({
          type: "text",
          orderIndex: partIdx++,
          textValue: step.text,
        });
      }

      messageRows.push({
        id: crypto.randomUUID(),
        role: "assistant",
        orderIndex: msgIdx++,
        parts,
      });
    }

    // Batch insert: messages first, then all parts
    const allMessages = messageRows.map((m) => ({
      id: m.id,
      executionId,
      role: m.role,
      orderIndex: m.orderIndex,
    }));

    const allParts = messageRows.flatMap((m) =>
      m.parts.map((p) => ({
        messageId: m.id,
        type: p.type,
        orderIndex: p.orderIndex,
        textValue: p.textValue ?? null,
        toolCallId: p.toolCallId ?? null,
        toolName: p.toolName ?? null,
        toolInput: p.toolInput ?? null,
        toolOutput: p.toolOutput ?? null,
        toolState: p.toolState ?? null,
      })),
    );

    await db.insert(jobExecutionMessages).values(allMessages);
    if (allParts.length > 0) {
      await db.insert(jobExecutionParts).values(allParts);
    }

    logger.info("persistExecutionConversation: saved", {
      executionId,
      messageCount: allMessages.length,
      partCount: allParts.length,
    });
  } catch (err: any) {
    logger.error("persistExecutionConversation: failed (non-fatal)", {
      executionId,
      error: err.message,
    });
  }
}
