/**
 * FULL-HARNESS counterfactual replay: re-run historical user asks through the
 * current production pipeline — current personality prompt, current main
 * model, current memory retrieval, and the FULL per-user tool set — with tool
 * execution INTERCEPTED so nothing fires twice (no duplicate emails, posts,
 * calls).
 *
 * vs. replay-compare.ts (generation-layer only), this version tests the two
 * failure modes that script cannot see:
 *   1. TOOL DISCOVERY/SELECTION — the model sees the real tool schemas (after
 *      credential filtering for the actual historical user via
 *      resolveUserCredentials), so "I don't have access to X" while the tool
 *      sat in the toolbox is measurable.
 *   2. MISSING-ACCESS CONFABULATION — the pairwise judge explicitly flags
 *      responses that claim a missing credential/capability.
 *
 * Tool interception, per call:
 *   - recorded:    same tool was called in the ORIGINAL trace → replay the
 *                  recorded output (exact-input match first, then first unused
 *                  call of the same tool).
 *   - synthesized: no recording → a fast-tier model fabricates a plausible
 *                  output (flagged in metrics; treat data-dependent wins with
 *                  care).
 *   - passthrough: harmless in-process tools (scratchpad, current time).
 *
 * Usage:
 *   pnpm tsx src/scripts/replay-compare-full.ts [--prod] [--limit=12] [--max-steps=12]
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

const limit = readNumberFlag("limit", 12);
const maxSteps = readNumberFlag("max-steps", 12);

const { sql, and, eq, asc, inArray } = await import("drizzle-orm");
const { generateText, generateObject } = await import("ai");
const { z } = await import("zod");
const { WebClient } = await import("@slack/web-api");
const { db } = await import("../db/client.js");
const { conversationMessages, conversationParts, conversationTraces } =
  await import("@aura/db/schema");
const { getMainModel, getFastModel, getFastModelId } = await import("../lib/ai.js");
const { executionContext } = await import("../lib/tool.js");
const { buildCorePrompt } = await import("../pipeline/core-prompt.js");
const { createAgenticStream } = await import("../pipeline/generate.js");
const { createSlackTools } = await import("../tools/slack.js");
const { buildTurns } = await import("../eval/windowing.js");

const CONTEXT_TURNS = 12;
const MAX_TURN_CHARS = 1_500;
const MAX_RESPONSE_CHARS = 6_000;
const PASSTHROUGH = /^(scratchpad_|get_current_datetime$)/;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [truncated]`;
}

function getRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

// ── Sampling: failed + partial first ─────────────────────────────────────────

type CaseRow = {
  score_id: string;
  message_id: string;
  trace_id: string;
  thread_ts: string | null;
  verdict: "fulfilled" | "partial" | "failed";
  serving_intent: string | null;
  channel_id: string | null;
  user_id: string | null;
};

// Balanced sample: half failed, a quarter partial, a quarter fulfilled (control).
const failedN = Math.ceil(limit / 2);
const partialN = Math.ceil(limit / 4);
const fulfilledN = limit - failedN - partialN;
const cases = getRows<CaseRow>(
  await db.execute(sql`
    (SELECT ers.id AS score_id, ers.message_id, ers.trace_id, ers.thread_ts,
            ers.verdict, ers.serving_intent, ct.channel_id, ct.user_id
     FROM eval_response_scores ers JOIN conversation_traces ct ON ct.id = ers.trace_id
     WHERE ers.scorable AND ers.verdict = 'failed' AND ct.user_id IS NOT NULL
     ORDER BY random() LIMIT ${failedN})
    UNION ALL
    (SELECT ers.id, ers.message_id, ers.trace_id, ers.thread_ts,
            ers.verdict, ers.serving_intent, ct.channel_id, ct.user_id
     FROM eval_response_scores ers JOIN conversation_traces ct ON ct.id = ers.trace_id
     WHERE ers.scorable AND ers.verdict = 'partial' AND ct.user_id IS NOT NULL
     ORDER BY random() LIMIT ${partialN})
    UNION ALL
    (SELECT ers.id, ers.message_id, ers.trace_id, ers.thread_ts,
            ers.verdict, ers.serving_intent, ct.channel_id, ct.user_id
     FROM eval_response_scores ers JOIN conversation_traces ct ON ct.id = ers.trace_id
     WHERE ers.scorable AND ers.verdict = 'fulfilled' AND ct.user_id IS NOT NULL
     ORDER BY random() LIMIT ${fulfilledN})
  `),
);

console.log(`=== FULL-HARNESS replay vs original — ${cases.length} cases ===`);

const { model: mainModel, modelId: mainModelId } = await getMainModel();
const fastModel = await getFastModel();
const fastModelId = await getFastModelId();
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
console.log(`Pipeline model: ${mainModelId} | judge/synthesizer: ${fastModelId}`);

// ── Tool interception ────────────────────────────────────────────────────────

interface RecordedCall {
  toolName: string;
  input: unknown;
  output: unknown;
  used: boolean;
}

interface ToolCallLog {
  name: string;
  source: "recorded" | "synthesized" | "passthrough";
}

function interceptTools(
  tools: Record<string, any>,
  recorded: RecordedCall[],
  log: ToolCallLog[],
): Record<string, any> {
  const wrapped: Record<string, any> = {};
  for (const [name, t] of Object.entries(tools)) {
    if (!t || typeof t.execute !== "function" || PASSTHROUGH.test(name)) {
      wrapped[name] = t;
      if (t && typeof t.execute === "function") {
        const original = t.execute.bind(t);
        t.execute = async (input: unknown) => {
          log.push({ name, source: "passthrough" });
          return original(input);
        };
      }
      continue;
    }
    wrapped[name] = {
      ...t,
      execute: async (input: unknown) => {
        // 1. Exact input match against the original run's recorded calls.
        const inputJson = JSON.stringify(input ?? {});
        let match = recorded.find(
          (r) =>
            !r.used &&
            r.toolName === name &&
            JSON.stringify(r.input ?? {}) === inputJson,
        );
        // 2. First unused recorded call of the same tool.
        match ??= recorded.find((r) => !r.used && r.toolName === name);
        if (match) {
          match.used = true;
          log.push({ name, source: "recorded" });
          return match.output ?? { ok: true };
        }
        // 3. Synthesize a plausible output (flagged in metrics).
        log.push({ name, source: "synthesized" });
        const { text } = await generateText({
          model: fastModel,
          system:
            "You simulate tool outputs inside a replay harness. Given a tool name, its description, and the call input, produce a SHORT plausible JSON result the real tool could have returned. Prefer empty-but-valid results (empty lists, ok:true acknowledgements) over invented specifics like names, numbers, or quotes. Output ONLY the JSON.",
          prompt: `Tool: ${name}\nDescription: ${clip(String(t.description ?? ""), 600)}\nInput: ${clip(inputJson, 800)}`,
          temperature: 0,
        });
        try {
          return JSON.parse(text);
        } catch {
          return { ok: true, simulated: true, output: clip(text, 800) };
        }
      },
    };
  }
  return wrapped;
}

// ── Per-case context ─────────────────────────────────────────────────────────

async function loadCase(c: CaseRow) {
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
  if (messages.length === 0) return null;

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
        inArray(
          conversationParts.messageId,
          messages.map((m) => m.id),
        ),
        inArray(conversationParts.type, ["text", "tool-invocation"]),
      ),
    )
    .orderBy(asc(conversationParts.orderIndex));

  const turns = buildTurns(traces, messages, parts);
  const idx = turns.findIndex((t) => t.messageId === c.message_id);
  if (idx < 0) return null;
  const originalText = turns[idx].text;

  // The user ask the scored response was serving + prior conversation.
  let lastUserIdx = -1;
  for (let i = idx - 1; i >= 0; i--) {
    if (turns[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return null;
  const lastUserText = turns[lastUserIdx].text;
  const priorTurns = turns.slice(Math.max(0, lastUserIdx - CONTEXT_TURNS), lastUserIdx);
  const conversationContext = priorTurns
    .map((t) =>
      t.role === "user"
        ? `${t.userId ?? "user"}: ${clip(t.text, MAX_TURN_CHARS)}`
        : `aura: ${clip(t.text, MAX_TURN_CHARS)}`,
    )
    .join("\n");

  // Recorded tool I/O of the ORIGINAL invocation (the replay cache).
  const sameTraceMsgIds = messages
    .filter((m) => m.conversationId === c.trace_id && m.role === "assistant")
    .map((m) => m.id);
  const recorded: RecordedCall[] =
    sameTraceMsgIds.length > 0
      ? getRows<{ tool_name: string | null; tool_input: unknown; tool_output: unknown }>(
          await db.execute(sql`
            SELECT tool_name, tool_input, tool_output FROM conversation_parts
            WHERE message_id IN ${sameTraceMsgIds} AND type = 'tool-invocation'
            ORDER BY order_index ASC
          `),
        ).map((r) => ({
          toolName: r.tool_name ?? "",
          input: r.tool_input,
          output: r.tool_output,
          used: false,
        }))
      : [];

  return { originalText, lastUserText, conversationContext, recorded };
}

// ── Pairwise judge (blind, shuffled) + missing-access flags ──────────────────

const pairwiseSchema = z.object({
  winner: z.enum(["A", "B", "tie"]),
  reason: z.string().describe("One or two sentences."),
  a_claims_missing_access: z
    .boolean()
    .describe(
      "True if candidate A claims it lacks access, credentials, an API key, or a capability needed for the ask.",
    ),
  b_claims_missing_access: z.boolean(),
});

interface CaseResult {
  scoreId: string;
  verdict: string;
  servingIntent: string | null;
  winner: "original" | "replay" | "tie";
  reason: string;
  toolCalls: ToolCallLog[];
  originalClaimsMissingAccess: boolean;
  replayClaimsMissingAccess: boolean;
}

const results: CaseResult[] = [];
let errors = 0;

for (const c of cases) {
  try {
    const ctx = await loadCase(c);
    if (!ctx) continue;

    // 1. Real per-user tool set (credential-filtered for the HISTORICAL user).
    const invocationId = crypto.randomUUID();
    const rawTools = await createSlackTools(
      slackClient,
      {
        userId: c.user_id ?? undefined,
        channelId: c.channel_id ?? undefined,
        threadTs: c.thread_ts ?? undefined,
        workspaceId: "default",
      },
      mainModelId,
      invocationId,
    );
    const toolLog: ToolCallLog[] = [];
    const tools = interceptTools(rawTools, ctx.recorded, toolLog);

    // 2. Current prompt layers for that user/channel (today's memories — see caveats).
    const prompt = await buildCorePrompt({
      channel: "slack",
      userId: c.user_id!,
      conversationId: c.channel_id ?? "unknown",
      threadId: c.thread_ts ?? undefined,
      messageText: ctx.lastUserText,
      conversationContext: ctx.conversationContext || undefined,
      isDirectMessage: (c.channel_id ?? "").startsWith("D"),
    });

    // 3. Run the CURRENT pipeline (same entrypoint new channels must use).
    const stream = executionContext.run(
      {
        triggeredBy: c.user_id ?? "replay",
        triggerType: "user_message",
        callingUserId: c.user_id ?? undefined,
        channelId: c.channel_id ?? undefined,
        threadTs: c.thread_ts ?? undefined,
        workspaceId: "default",
      },
      () =>
        createAgenticStream({
          model: mainModel,
          modelId: mainModelId,
          tools,
          stablePrefix: prompt.stablePrefix,
          environmentContext: prompt.environmentContext,
          conversationContext: prompt.conversationContext,
          dynamicContext: prompt.dynamicContext,
          messages: [{ role: "user", content: ctx.lastUserText }],
          maxSteps,
          userId: c.user_id ?? undefined,
          channelId: c.channel_id ?? undefined,
          threadTs: c.thread_ts ?? undefined,
          invocationId,
        }),
    );
    const replayText = await stream.text;
    if (!replayText.trim()) continue;

    // 4. Blind pairwise judgement.
    const replayFirst = Math.random() < 0.5;
    const A = replayFirst ? replayText : ctx.originalText;
    const B = replayFirst ? ctx.originalText : replayText;
    const { object: judged } = await generateObject({
      model: fastModel,
      schema: pairwiseSchema,
      system:
        "You compare two candidate replies from an AI assistant in a Slack conversation and pick the one that better FULFILLS the user's intent: more correct, grounded, complete, actionable. Tone/length only break ties. Also flag, for each candidate, whether it claims to lack access, credentials, an API key, or a capability. You do not know which candidate is newer — judge only quality.",
      prompt: `<conversation_so_far>\n${ctx.conversationContext}\n</conversation_so_far>\n\nUSER'S ASK: ${clip(ctx.lastUserText, MAX_TURN_CHARS)}\n\n<candidate_A>\n${clip(A, MAX_RESPONSE_CHARS)}\n</candidate_A>\n\n<candidate_B>\n${clip(B, MAX_RESPONSE_CHARS)}\n</candidate_B>`,
      temperature: 0,
    });

    const winner =
      judged.winner === "tie"
        ? ("tie" as const)
        : (judged.winner === "A") === replayFirst
          ? ("replay" as const)
          : ("original" as const);

    const result: CaseResult = {
      scoreId: c.score_id,
      verdict: c.verdict,
      servingIntent: c.serving_intent,
      winner,
      reason: judged.reason,
      toolCalls: toolLog,
      originalClaimsMissingAccess: replayFirst
        ? judged.b_claims_missing_access
        : judged.a_claims_missing_access,
      replayClaimsMissingAccess: replayFirst
        ? judged.a_claims_missing_access
        : judged.b_claims_missing_access,
    };
    results.push(result);
    console.log(
      `  [${results.length}/${cases.length}] ${c.verdict.padEnd(9)} -> ${result.winner.padEnd(8)} tools:${toolLog.length} (${toolLog.filter((t) => t.source === "recorded").length} recorded/${toolLog.filter((t) => t.source === "synthesized").length} synth) ${result.replayClaimsMissingAccess ? "⚠ replay claims missing access " : ""}${(c.serving_intent ?? "").slice(0, 50)}`,
    );
  } catch (error) {
    errors++;
    console.error(
      `  case ${c.score_id} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

const artifact = `/tmp/replay-full-${Date.now()}.jsonl`;
writeFileSync(artifact, results.map((r) => JSON.stringify(r)).join("\n"));

const tally = { replay: 0, original: 0, tie: 0 };
for (const r of results) tally[r.winner]++;
const totalToolCalls = results.reduce((s, r) => s + r.toolCalls.length, 0);
const recordedCalls = results.reduce(
  (s, r) => s + r.toolCalls.filter((t) => t.source === "recorded").length,
  0,
);
const synthCalls = results.reduce(
  (s, r) => s + r.toolCalls.filter((t) => t.source === "synthesized").length,
  0,
);

console.log(`\n=== FULL-HARNESS results (n=${results.length}) ===`);
for (const bucket of ["failed", "partial", "fulfilled"]) {
  const rows = results.filter((r) => r.verdict === bucket);
  if (rows.length === 0) continue;
  const t = { replay: 0, original: 0, tie: 0 };
  for (const r of rows) t[r.winner]++;
  console.log(
    `originally ${bucket.padEnd(9)} (n=${rows.length}): replay wins ${t.replay}, original wins ${t.original}, ties ${t.tie}`,
  );
}
console.log(
  `ALL: replay wins ${tally.replay}, original wins ${tally.original}, ties ${tally.tie}`,
);
console.log(
  `Tool calls in replays: ${totalToolCalls} total (${recordedCalls} replayed from recordings, ${synthCalls} synthesized) across ${results.filter((r) => r.toolCalls.length > 0).length}/${results.length} cases`,
);
console.log(
  `Missing-access claims: original ${results.filter((r) => r.originalClaimsMissingAccess).length}, replay ${results.filter((r) => r.replayClaimsMissingAccess).length}`,
);
if (errors > 0) console.log(`Case errors: ${errors}`);
console.log(`Artifact: ${artifact}`);
process.exit(0);
