import { generateObject } from "ai";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { evalResponseScores } from "@aura/db/schema";
import { db } from "../db/client.js";
import { getFastModel, getFastModelId } from "../lib/ai.js";
import { aiTelemetry, withTrace } from "../lib/langfuse.js";
import { logger } from "../lib/logger.js";
import { pool } from "../lib/pool.js";

const CORPUS_START = "2026-03-12T00:00:00.000Z";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_CONCURRENCY = 2;
const WINDOW_TRACE_COUNT = 20;
const MAX_PART_CHARS = 6_000;

const verdictSchema = z.enum(["fulfilled", "partial", "failed"]);
const failureClassSchema = z.enum([
  "missing_cred",
  "bad_memory",
  "bad_harness",
  "missing_tool",
  "reasoning",
  "latency",
  "none",
]);

const scoreWindowSchema = z.object({
  scores: z.array(
    z.object({
      part_id: z.string().uuid(),
      scorable: z.boolean(),
      verdict: verdictSchema,
      failure_class: failureClassSchema,
      serving_intent: z.string().max(1_000).nullable(),
      resolved_in_window: z.boolean(),
      note: z.string().max(2_000).nullable(),
    }),
  ),
});

type ScoreWindowResult = z.infer<typeof scoreWindowSchema>;
type Verdict = z.infer<typeof verdictSchema>;
type FailureClass = z.infer<typeof failureClassSchema>;

type QueryResult<T> = { rows?: T[] } | T[];

function getRows<T>(result: QueryResult<T>): T[] {
  return Array.isArray(result) ? result : result.rows ?? [];
}

type CandidatePart = {
  workspace_id: string;
  part_id: string;
  message_id: string;
  trace_id: string;
  channel_id: string | null;
  thread_ts: string | null;
  trace_created_at: Date | string;
};

type WindowRow = {
  workspace_id: string;
  trace_id: string;
  trace_created_at: Date | string;
  channel_id: string | null;
  thread_ts: string | null;
  user_id: string | null;
  message_id: string;
  role: "system" | "user" | "assistant";
  content: string | null;
  message_order_index: number;
  message_created_at: Date | string;
  part_id: string | null;
  part_type: string | null;
  part_order_index: number | null;
  text_value: string | null;
  tool_name: string | null;
  tool_state: string | null;
};

type TranscriptPart = {
  id: string;
  type: string;
  orderIndex: number;
  textValue: string | null;
  toolName: string | null;
  toolState: string | null;
};

type TranscriptMessage = {
  workspaceId: string;
  traceId: string;
  traceCreatedAt: string;
  channelId: string | null;
  threadTs: string | null;
  userId: string | null;
  messageId: string;
  role: "system" | "user" | "assistant";
  content: string | null;
  orderIndex: number;
  createdAt: string;
  parts: TranscriptPart[];
};

type TargetPart = {
  workspaceId: string;
  partId: string;
  messageId: string;
  traceId: string;
  threadTs: string | null;
};

type EvalWindow = {
  key: string;
  focal: CandidatePart;
  messages: TranscriptMessage[];
  targetParts: TargetPart[];
};

export type ResponseScoreBatchResult = {
  candidates: number;
  windows: number;
  scored: number;
  inserted: number;
  errors: number;
};

function boundedLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(limit), MAX_LIMIT));
}

function truncateForPrompt(value: string, maxChars = MAX_PART_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n... [truncated ${value.length - maxChars} chars]`;
}

async function loadUnscoredAssistantParts(limit: number): Promise<CandidatePart[]> {
  return getRows<CandidatePart>(
    await db.execute(sql`
      SELECT
        cp.workspace_id,
        cp.id AS part_id,
        cp.message_id,
        cm.conversation_id AS trace_id,
        ct.channel_id,
        ct.thread_ts,
        ct.created_at AS trace_created_at
      FROM conversation_parts cp
      JOIN conversation_messages cm ON cm.id = cp.message_id
      JOIN conversation_traces ct ON ct.id = cm.conversation_id
      LEFT JOIN eval_response_scores ers
        ON ers.workspace_id = cp.workspace_id
       AND ers.part_id = cp.id
      WHERE cm.role = 'assistant'
        AND cp.type = 'text'
        AND cp.text_value IS NOT NULL
        AND length(trim(cp.text_value)) > 0
        AND ers.part_id IS NULL
        AND ct.created_at >= ${CORPUS_START}::timestamptz
      ORDER BY ct.created_at ASC, cm.order_index ASC, cp.order_index ASC
      LIMIT ${limit}
    `),
  );
}

function windowKey(candidate: CandidatePart): string {
  const threadKey = candidate.channel_id && candidate.thread_ts
    ? `${candidate.channel_id}:${candidate.thread_ts}`
    : `trace:${candidate.trace_id}`;
  return `${candidate.workspace_id}:${threadKey}:${candidate.trace_id}`;
}

function dateIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function buildMessages(rows: WindowRow[]): TranscriptMessage[] {
  const messages = new Map<string, TranscriptMessage>();

  for (const row of rows) {
    let msg = messages.get(row.message_id);
    if (!msg) {
      msg = {
        workspaceId: row.workspace_id,
        traceId: row.trace_id,
        traceCreatedAt: dateIso(row.trace_created_at),
        channelId: row.channel_id,
        threadTs: row.thread_ts,
        userId: row.user_id,
        messageId: row.message_id,
        role: row.role,
        content: row.content,
        orderIndex: row.message_order_index,
        createdAt: dateIso(row.message_created_at),
        parts: [],
      };
      messages.set(row.message_id, msg);
    }

    if (row.part_id && row.part_type && row.part_order_index != null) {
      msg.parts.push({
        id: row.part_id,
        type: row.part_type,
        orderIndex: row.part_order_index,
        textValue: row.text_value,
        toolName: row.tool_name,
        toolState: row.tool_state,
      });
    }
  }

  return [...messages.values()].map((message) => ({
    ...message,
    parts: message.parts.sort((a, b) => a.orderIndex - b.orderIndex),
  }));
}

async function loadWindow(candidate: CandidatePart): Promise<EvalWindow | null> {
  const rows = candidate.channel_id && candidate.thread_ts
    ? getRows<WindowRow>(
      await db.execute(sql`
        WITH window_traces AS (
          SELECT id, created_at
          FROM conversation_traces
          WHERE workspace_id = ${candidate.workspace_id}
            AND channel_id = ${candidate.channel_id}
            AND thread_ts = ${candidate.thread_ts}
            AND created_at <= ${candidate.trace_created_at}::timestamptz
          ORDER BY created_at DESC
          LIMIT ${WINDOW_TRACE_COUNT}
        )
        SELECT
          ct.workspace_id,
          ct.id AS trace_id,
          ct.created_at AS trace_created_at,
          ct.channel_id,
          ct.thread_ts,
          ct.user_id,
          cm.id AS message_id,
          cm.role,
          cm.content,
          cm.order_index AS message_order_index,
          cm.created_at AS message_created_at,
          cp.id AS part_id,
          cp.type AS part_type,
          cp.order_index AS part_order_index,
          cp.text_value,
          cp.tool_name,
          cp.tool_state
        FROM window_traces wt
        JOIN conversation_traces ct ON ct.id = wt.id
        JOIN conversation_messages cm ON cm.conversation_id = ct.id
        LEFT JOIN conversation_parts cp ON cp.message_id = cm.id
        ORDER BY ct.created_at ASC, cm.order_index ASC, cp.order_index ASC
      `),
    )
    : getRows<WindowRow>(
      await db.execute(sql`
        SELECT
          ct.workspace_id,
          ct.id AS trace_id,
          ct.created_at AS trace_created_at,
          ct.channel_id,
          ct.thread_ts,
          ct.user_id,
          cm.id AS message_id,
          cm.role,
          cm.content,
          cm.order_index AS message_order_index,
          cm.created_at AS message_created_at,
          cp.id AS part_id,
          cp.type AS part_type,
          cp.order_index AS part_order_index,
          cp.text_value,
          cp.tool_name,
          cp.tool_state
        FROM conversation_traces ct
        JOIN conversation_messages cm ON cm.conversation_id = ct.id
        LEFT JOIN conversation_parts cp ON cp.message_id = cm.id
        WHERE ct.id = ${candidate.trace_id}
        ORDER BY ct.created_at ASC, cm.order_index ASC, cp.order_index ASC
      `),
    );

  if (rows.length === 0) return null;

  const messages = buildMessages(rows);
  const targetParts: TargetPart[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "text" || !part.textValue?.trim()) continue;
      targetParts.push({
        workspaceId: message.workspaceId,
        partId: part.id,
        messageId: message.messageId,
        traceId: message.traceId,
        threadTs: message.threadTs,
      });
    }
  }

  if (targetParts.length === 0) return null;
  return { key: windowKey(candidate), focal: candidate, messages, targetParts };
}

function formatTranscript(window: EvalWindow): string {
  const lines: string[] = [
    "Conversation window. Score every assistant response marker [R:<part_id>] independently.",
    `Focal trace: ${window.focal.trace_id}`,
    "",
  ];

  let currentTraceId: string | null = null;
  for (const message of window.messages) {
    if (message.traceId !== currentTraceId) {
      currentTraceId = message.traceId;
      lines.push(
        "",
        `--- TRACE ${message.traceId} at ${message.traceCreatedAt} user=${message.userId ?? "unknown"} ---`,
      );
    }

    lines.push(`${message.role.toUpperCase()} message ${message.messageId}:`);
    const textParts = message.parts.filter((part) => part.type === "text" && part.textValue);
    if (message.role === "assistant") {
      for (const part of textParts) {
        lines.push(`[R:${part.id}]`);
        lines.push(truncateForPrompt(part.textValue ?? ""));
        lines.push("[/R]");
      }
    } else if (textParts.length > 0) {
      lines.push(truncateForPrompt(textParts.map((part) => part.textValue).join("\n\n")));
    } else if (message.content) {
      lines.push(truncateForPrompt(message.content));
    } else {
      lines.push("(no text content)");
    }

    const toolParts = message.parts.filter((part) => part.type === "tool-invocation");
    for (const part of toolParts) {
      lines.push(`TOOL ${part.toolName ?? "unknown"} state=${part.toolState ?? "unknown"}`);
    }
  }

  lines.push("", "Target part IDs:", ...window.targetParts.map((part) => `- ${part.partId}`));
  return lines.join("\n");
}

async function judgeWindow(
  window: EvalWindow,
  model: Awaited<ReturnType<typeof getFastModel>>,
  judgeModel: string,
): Promise<ScoreWindowResult> {
  return withTrace(
    {
      traceName: "eval-response-score-window",
      sessionId: window.focal.thread_ts || window.focal.trace_id,
      metadata: {
        focalTraceId: window.focal.trace_id,
        channelId: window.focal.channel_id,
        targetParts: window.targetParts.length,
        judgeModel,
      },
      tags: ["eval-response-scores"],
    },
    async () => {
      const { object } = await generateObject({
        model,
        schema: scoreWindowSchema,
        experimental_telemetry: aiTelemetry("eval-response-score-window"),
        system: `You are Aura's independent response-quality judge.

Task: for each assistant response marker [R:part_id], decide whether that specific response fulfilled the nearest open user intent in the surrounding window.

Rules:
- Return exactly one array entry for each target part_id you can judge. Echo the exact part_id string; never rely on order.
- Atomic verdict: judge only the marked assistant response, but use prior and following turns in the window for context.
- scorable=false for pure acknowledgements, clarifying questions, tool-relay/status updates, or responses that do not attempt to close or fumble a user intent. For non-scorable rows use verdict="fulfilled" and failure_class="none".
- scorable=true when the response substantively answers, acts on, closes, partially satisfies, or fumbles a user request.
- resolved_in_window=true when an apparently incomplete/hedged response is later resolved within this window.
- failure_class must be "none" unless verdict is "partial" or "failed".
- "missing_cred" means blocked by unavailable credentials/permissions.
- "bad_memory" means wrong, stale, or missing remembered facts caused the issue.
- "bad_harness" means the trace/tooling/eval setup is the likely problem, not Aura's answer.
- "missing_tool" means Aura needed a tool/capability she lacks.
- "reasoning" means planning, understanding, factual, or execution reasoning failed.
- "latency" means timeliness or excessive waiting was the main failure.
Return only the structured object.`,
        prompt: formatTranscript(window),
        temperature: 0,
      });
      return object;
    },
  );
}

function normalizeFailureClass(verdict: Verdict, failureClass: FailureClass): FailureClass {
  if (verdict === "fulfilled") return "none";
  return failureClass;
}

async function persistScores(
  window: EvalWindow,
  scores: ScoreWindowResult,
  judgeModel: string,
): Promise<{ scored: number; inserted: number }> {
  const targets = new Map(window.targetParts.map((part) => [part.partId, part]));
  const values = scores.scores
    .map((score) => {
      const target = targets.get(score.part_id);
      if (!target) return null;
      return {
        workspaceId: target.workspaceId,
        messageId: target.messageId,
        partId: target.partId,
        traceId: target.traceId,
        threadTs: target.threadTs,
        servingIntent: score.serving_intent?.trim() || null,
        resolvedInWindow: score.resolved_in_window,
        verdict: score.verdict,
        scorable: score.scorable,
        failureClass: normalizeFailureClass(score.verdict, score.failure_class),
        note: score.note?.trim() || null,
        judgeModel,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);

  if (values.length === 0) return { scored: 0, inserted: 0 };

  const inserted = await db
    .insert(evalResponseScores)
    .values(values)
    .onConflictDoNothing({
      target: [evalResponseScores.workspaceId, evalResponseScores.partId],
    })
    .returning({ partId: evalResponseScores.partId });

  return { scored: values.length, inserted: inserted.length };
}

export async function scoreUnscoredResponses(options: {
  limit?: number;
  concurrency?: number;
} = {}): Promise<ResponseScoreBatchResult> {
  const limit = boundedLimit(options.limit);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 5));
  const candidates = await loadUnscoredAssistantParts(limit);
  const windows = new Map<string, CandidatePart>();

  for (const candidate of candidates) {
    windows.set(windowKey(candidate), candidate);
  }

  const model = await getFastModel();
  const judgeModel = await getFastModelId();
  const result: ResponseScoreBatchResult = {
    candidates: candidates.length,
    windows: windows.size,
    scored: 0,
    inserted: 0,
    errors: 0,
  };

  await pool([...windows.values()], concurrency, async (candidate) => {
    try {
      const window = await loadWindow(candidate);
      if (!window) return;
      const scores = await judgeWindow(window, model, judgeModel);
      const persisted = await persistScores(window, scores, judgeModel);
      result.scored += persisted.scored;
      result.inserted += persisted.inserted;
    } catch (error) {
      result.errors += 1;
      logger.error("Failed to score eval response window", {
        error: String(error),
        traceId: candidate.trace_id,
        partId: candidate.part_id,
      });
    }
  });

  return result;
}
