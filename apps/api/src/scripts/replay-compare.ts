/**
 * Counterfactual replay: does TODAY's harness beat the responses Aura
 * originally shipped?
 *
 * For a sample of judged responses from `eval_response_scores`, this replays
 * the GENERATION layer of the current harness — today's personality/system
 * prompt (`buildStablePrefix()`, DB-backed) + today's main model — against the
 * exact same inputs the original run had: the prior thread turns and the
 * original tool evidence. A blind pairwise judge (fast tier, shuffled A/B)
 * then picks which response better fulfills the user's intent.
 *
 * HONEST SCOPE — what this does and does not measure:
 *   - Measures: prompt + model + response-style improvements ("what Aura says
 *     given the same evidence").
 *   - Does NOT measure: tool selection, memory retrieval, or agentic-loop
 *     changes. Re-executing tools live would fire real side effects (emails,
 *     Slack posts) — that full as-of replay engine is issue #1106.
 *   - The original response had its original system prompt (incl. memories of
 *     the day); the replay gets today's core prompt but NO per-user memories.
 *
 * Usage:
 *   pnpm tsx src/scripts/replay-compare.ts [--prod] [--limit=40] [--concurrency=3]
 *
 * Writes a JSONL artifact to /tmp/replay-compare-<ts>.jsonl and prints a
 * summary by original verdict bucket.
 */
import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
config({ path: resolve(repoRoot, isProd ? ".env.production" : ".env.local") });
if (isProd) console.log("Using .env.production (--prod)");

function readNumberFlag(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return fallback;
  const value = Number(arg.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const limit = readNumberFlag("limit", 40);
const concurrency = readNumberFlag("concurrency", 3);

const { sql, and, eq, asc, inArray } = await import("drizzle-orm");
const { generateText, generateObject } = await import("ai");
const { z } = await import("zod");
const { db } = await import("../db/client.js");
const {
  conversationMessages,
  conversationParts,
  conversationTraces,
} = await import("@aura/db/schema");
const { getMainModel, getFastModel, getFastModelId, withCacheControl } =
  await import("../lib/ai.js");
const { buildStablePrefix } = await import("../personality/system-prompt.js");
const { buildTurns } = await import("../eval/windowing.js");
const { pool } = await import("../lib/pool.js");

const CONTEXT_TURNS = 12;
const MAX_TURN_CHARS = 1_500;
const MAX_TOOL_OUTPUT_CHARS = 1_200;
const MAX_RESPONSE_CHARS = 6_000;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [truncated]`;
}

function getRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

// ── 1. Sample judged responses (all failed, all partial, fill with fulfilled) ─

type CaseRow = {
  score_id: string;
  message_id: string;
  part_id: string;
  trace_id: string;
  thread_ts: string | null;
  verdict: "fulfilled" | "partial" | "failed";
  serving_intent: string | null;
  channel_id: string | null;
  user_id: string | null;
};

const cases = getRows<CaseRow>(
  await db.execute(sql`
    SELECT ers.id AS score_id, ers.message_id, ers.part_id, ers.trace_id,
           ers.thread_ts, ers.verdict, ers.serving_intent,
           ct.channel_id, ct.user_id
    FROM eval_response_scores ers
    JOIN conversation_traces ct ON ct.id = ers.trace_id
    WHERE ers.scorable AND ers.verdict IS NOT NULL
    ORDER BY CASE ers.verdict WHEN 'failed' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,
             random()
    LIMIT ${limit}
  `),
);

console.log(`=== Replay vs Original — ${cases.length} cases ===`);
const byVerdict: Record<string, number> = {};
for (const c of cases) byVerdict[c.verdict] = (byVerdict[c.verdict] ?? 0) + 1;
console.log("Sample by original verdict:", byVerdict);

// ── 2. Shared harness pieces ─────────────────────────────────────────────────

const stablePrefix = await buildStablePrefix();
const { model: mainModel, modelId: mainModelId } = await getMainModel();
const fastModel = await getFastModel();
const fastModelId = await getFastModelId();
console.log(`Replay model (current main): ${mainModelId}`);
console.log(`Pairwise judge (fast tier): ${fastModelId}`);

const REPLAY_NOTE = `You are replying inside an existing Slack conversation. This is a replay environment: your tools are NOT available, so do not attempt tool calls — base your reply entirely on the conversation and the tool evidence provided (it is the real output of the tools you ran for this turn). Write the single best reply to the user's last message, in Slack mrkdwn, in your normal voice. Do not mention the replay.`;

// ── 3. Per-case replay + blind pairwise judgement ────────────────────────────

interface CaseResult {
  scoreId: string;
  verdict: string;
  servingIntent: string | null;
  winner: "original" | "replay" | "tie";
  reason: string;
  originalChars: number;
  replayChars: number;
}

const pairwiseSchema = z.object({
  winner: z.enum(["A", "B", "tie"]),
  reason: z.string().describe("One or two sentences."),
});

async function buildCaseContext(c: CaseRow): Promise<{
  contextBlock: string;
  originalText: string;
} | null> {
  const traces = c.thread_ts
    ? await db
        .select()
        .from(conversationTraces)
        .where(
          and(
            sql`coalesce(${conversationTraces.channelId}, '') = ${c.channel_id ?? ""}`,
            eq(conversationTraces.threadTs, c.thread_ts),
          ),
        )
        .orderBy(asc(conversationTraces.createdAt))
    : await db
        .select()
        .from(conversationTraces)
        .where(eq(conversationTraces.id, c.trace_id));
  if (traces.length === 0) return null;

  const traceIds = traces.map((t) => t.id);
  const messages = await db
    .select()
    .from(conversationMessages)
    .where(
      and(
        inArray(conversationMessages.conversationId, traceIds),
        inArray(conversationMessages.role, ["user", "assistant"]),
      ),
    )
    .orderBy(asc(conversationMessages.orderIndex));
  const messageIds = messages.map((m) => m.id);
  if (messageIds.length === 0) return null;

  const parts = await db
    .select({
      id: conversationParts.id,
      messageId: conversationParts.messageId,
      type: conversationParts.type,
      orderIndex: conversationParts.orderIndex,
      textValue: conversationParts.textValue,
      toolName: conversationParts.toolName,
    })
    .from(conversationParts)
    .where(
      and(
        inArray(conversationParts.messageId, messageIds),
        inArray(conversationParts.type, ["text", "tool-invocation"]),
      ),
    )
    .orderBy(asc(conversationParts.orderIndex));

  const turns = buildTurns(traces, messages, parts);
  const idx = turns.findIndex((t) => t.messageId === c.message_id);
  if (idx < 0) return null;

  const originalText = turns[idx].text;
  const priorTurns = turns.slice(Math.max(0, idx - CONTEXT_TURNS), idx);
  const conversation = priorTurns
    .map((t) =>
      t.role === "user"
        ? `USER${t.userId ? ` ${t.userId}` : ""}: ${clip(t.text, MAX_TURN_CHARS)}`
        : `AURA: ${clip(t.text, MAX_TURN_CHARS)}`,
    )
    .join("\n\n");

  // Tool evidence: the work Aura did within THIS invocation before answering.
  const scoredMessage = messages.find((m) => m.id === c.message_id);
  const sameTraceMessageIds = messages
    .filter(
      (m) =>
        m.conversationId === c.trace_id &&
        m.role === "assistant" &&
        scoredMessage &&
        m.orderIndex <= scoredMessage.orderIndex,
    )
    .map((m) => m.id);
  const evidence =
    sameTraceMessageIds.length > 0
      ? getRows<{ tool_name: string | null; tool_input: unknown; tool_output: unknown }>(
          await db.execute(sql`
            SELECT tool_name, tool_input, tool_output
            FROM conversation_parts
            WHERE message_id IN ${sameTraceMessageIds}
              AND type = 'tool-invocation'
            ORDER BY order_index ASC
          `),
        )
      : [];
  const evidenceBlock = evidence
    .map(
      (e) =>
        `TOOL ${e.tool_name ?? "unknown"}\ninput: ${clip(JSON.stringify(e.tool_input) ?? "null", 400)}\noutput: ${clip(JSON.stringify(e.tool_output) ?? "null", MAX_TOOL_OUTPUT_CHARS)}`,
    )
    .join("\n\n");

  const contextBlock = [
    conversation
      ? `<conversation_so_far>\n${conversation}\n</conversation_so_far>`
      : "",
    evidenceBlock
      ? `<tool_evidence_for_this_turn>\n${evidenceBlock}\n</tool_evidence_for_this_turn>`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { contextBlock, originalText };
}

async function runCase(c: CaseRow): Promise<CaseResult | null> {
  const ctx = await buildCaseContext(c);
  if (!ctx || !ctx.contextBlock.trim()) return null;

  // Replay with TODAY's harness core: current personality prompt + main model.
  const { text: replayText } = await generateText({
    model: mainModel,
    messages: [
      withCacheControl(stablePrefix),
      { role: "system", content: REPLAY_NOTE },
      {
        role: "user",
        content: `${ctx.contextBlock}\n\nNow write your reply to the user's last message.`,
      },
    ],
    temperature: 0,
  });
  if (!replayText.trim()) return null;

  // Blind pairwise judgement, shuffled order.
  const replayFirst = Math.random() < 0.5;
  const A = replayFirst ? replayText : ctx.originalText;
  const B = replayFirst ? ctx.originalText : replayText;

  const { object: judged } = await generateObject({
    model: fastModel,
    schema: pairwiseSchema,
    instructions: `You compare two candidate replies from an AI assistant in a Slack conversation and pick the one that better FULFILLS the user's intent: more correct, grounded in the provided evidence (no fabricated facts), complete, and actionable. Tone/length only break ties. Declare "tie" when neither is meaningfully better. You do not know which candidate is newer — judge only quality.`,
    prompt: `${ctx.contextBlock}\n\n<candidate_A>\n${clip(A, MAX_RESPONSE_CHARS)}\n</candidate_A>\n\n<candidate_B>\n${clip(B, MAX_RESPONSE_CHARS)}\n</candidate_B>\n\nWhich candidate better fulfills the user's intent?`,
    temperature: 0,
  });

  const winner =
    judged.winner === "tie"
      ? ("tie" as const)
      : (judged.winner === "A") === replayFirst
        ? ("replay" as const)
        : ("original" as const);

  return {
    scoreId: c.score_id,
    verdict: c.verdict,
    servingIntent: c.serving_intent,
    winner,
    reason: judged.reason,
    originalChars: ctx.originalText.length,
    replayChars: replayText.length,
  };
}

const results: CaseResult[] = [];
let failures = 0;
await pool(cases, concurrency, async (c) => {
  try {
    const result = await runCase(c);
    if (result) {
      results.push(result);
      console.log(
        `  [${results.length}/${cases.length}] ${c.verdict.padEnd(9)} -> ${result.winner.padEnd(8)} ${(c.serving_intent ?? "").slice(0, 60)}`,
      );
    }
  } catch (error) {
    failures++;
    console.error(
      `  case ${c.score_id} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

// ── 4. Summary ───────────────────────────────────────────────────────────────

const artifact = `/tmp/replay-compare-${Date.now()}.jsonl`;
writeFileSync(artifact, results.map((r) => JSON.stringify(r)).join("\n"));

function tally(rows: CaseResult[]) {
  const t = { replay: 0, original: 0, tie: 0 };
  for (const r of rows) t[r.winner]++;
  return t;
}

console.log("\n=== Results (blind pairwise, judged by", fastModelId, ") ===");
const buckets = ["failed", "partial", "fulfilled"] as const;
for (const bucket of buckets) {
  const rows = results.filter((r) => r.verdict === bucket);
  if (rows.length === 0) continue;
  const t = tally(rows);
  console.log(
    `originally ${bucket.padEnd(9)} (n=${rows.length}): replay wins ${t.replay}, original wins ${t.original}, ties ${t.tie}`,
  );
}
const all = tally(results);
console.log(
  `ALL (n=${results.length}): replay wins ${all.replay} (${Math.round((all.replay / results.length) * 100)}%), original wins ${all.original} (${Math.round((all.original / results.length) * 100)}%), ties ${all.tie}`,
);
if (failures > 0) console.log(`Case errors: ${failures}`);
console.log(`Artifact: ${artifact}`);
