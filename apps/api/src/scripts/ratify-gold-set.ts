/**
 * Human ratification CLI for the eval response gold set (Machine A -> Machine B).
 *
 * Usage:
 *   pnpm ratify:gold-set --list --limit 25
 *   pnpm ratify:gold-set --list --failure-class bad_memory
 *   pnpm ratify:gold-set --ratify <row_id> --gold "Expected answer" --rubric '{"must_do":["..."]}' --by "Name"
 *   pnpm ratify:gold-set --export > ratified-eval-cases.json
 */
import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import type { EvalFailureClass, EvalRubric } from "@aura/db/schema";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
config({ path: resolve(repoRoot, isProd ? ".env.production" : ".env.local") });
if (isProd) console.error("Using .env.production (--prod)");

function usage(): never {
  console.error(`Usage:
  pnpm ratify:gold-set --list [--failure-class bad_memory] [--limit N] [--prod]
  pnpm ratify:gold-set --ratify <row_id> --gold "answer" --rubric '{"must_do":["..."]}' --by <name> [--prod]
  pnpm ratify:gold-set --export [--prod]`);
  process.exit(1);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readFlag(name: string): string | undefined {
  const exact = `--${name}`;
  const prefix = `${exact}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === exact) return process.argv[i + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function readLimit(): number {
  const value = Number(readFlag("limit") ?? 25);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 200) : 25;
}

function parseRubric(raw: string): EvalRubric {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`Invalid --rubric JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("--rubric must be a JSON object");
    process.exit(1);
  }
  return parsed as EvalRubric;
}

function truncate(text: string | null | undefined, max = 180): string {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function slackThreadLink(channelId: string | null, threadTs: string | null): string | null {
  if (!channelId || !threadTs) return null;
  const domain = process.env.SLACK_WORKSPACE_DOMAIN || "realadvisor";
  return `https://${domain}.slack.com/archives/${channelId}/p${threadTs.replace(/\D/g, "")}`;
}

const actionCount =
  (hasFlag("list") ? 1 : 0) + (readFlag("ratify") ? 1 : 0) + (hasFlag("export") ? 1 : 0);
if (actionCount !== 1) usage();

const { and, asc, desc, eq, inArray, isNotNull, isNull, sql } = await import(
  "drizzle-orm"
);
const {
  conversationMessages,
  conversationParts,
  conversationTraces,
  evalFailureClasses,
  evalResponseScores,
} = await import("@aura/db/schema");
const { db } = await import("../db/client.js");
const { buildTurns } = await import("../eval/windowing.js");

function readFailureClass(): EvalFailureClass | undefined {
  const raw = readFlag("failure-class");
  if (!raw) return undefined;
  if (!(evalFailureClasses as readonly string[]).includes(raw)) {
    console.error(`Invalid --failure-class: ${raw}`);
    process.exit(1);
  }
  return raw as EvalFailureClass;
}

async function listQueue() {
  const failureClass = readFailureClass();
  const conditions = [
    eq(evalResponseScores.scorable, true),
    sql`${evalResponseScores.verdict} in ('failed', 'partial')`,
    isNull(evalResponseScores.ratifiedBy),
  ];
  if (failureClass) conditions.push(eq(evalResponseScores.failureClass, failureClass));

  const rows = await db
    .select({
      id: evalResponseScores.id,
      verdict: evalResponseScores.verdict,
      failureClass: evalResponseScores.failureClass,
      note: evalResponseScores.note,
      servingIntent: evalResponseScores.servingIntent,
      channelId: conversationTraces.channelId,
      threadTs: evalResponseScores.threadTs,
      traceCreatedAt: conversationTraces.createdAt,
      text: conversationParts.textValue,
    })
    .from(evalResponseScores)
    .innerJoin(conversationTraces, eq(evalResponseScores.traceId, conversationTraces.id))
    .innerJoin(conversationParts, eq(evalResponseScores.partId, conversationParts.id))
    .where(and(...conditions))
    .orderBy(desc(conversationTraces.createdAt), desc(evalResponseScores.createdAt))
    .limit(readLimit());

  for (const row of rows) {
    const link = slackThreadLink(row.channelId, row.threadTs);
    console.log([
      `id: ${row.id}`,
      `verdict: ${row.verdict}/${row.failureClass}`,
      `created: ${row.traceCreatedAt.toISOString()}`,
      `thread: ${link ?? "(no Slack thread link)"}`,
      `intent: ${truncate(row.servingIntent, 240) || "(none)"}`,
      `note: ${truncate(row.note, 300) || "(none)"}`,
      `excerpt: ${truncate(row.text, 300) || "(empty)"}`,
    ].join("\n"));
    console.log("");
  }
  console.error(`Listed ${rows.length} ratification candidate(s).`);
}

async function ratifyOne() {
  const rowId = readFlag("ratify");
  const gold = readFlag("gold");
  const rubricRaw = readFlag("rubric");
  const by = readFlag("by");
  if (!rowId || !gold || !rubricRaw || !by) usage();

  const [updated] = await db
    .update(evalResponseScores)
    .set({
      goldAnswer: gold,
      rubric: parseRubric(rubricRaw),
      ratifiedBy: by,
    })
    .where(
      and(
        eq(evalResponseScores.id, rowId),
        eq(evalResponseScores.scorable, true),
        sql`${evalResponseScores.verdict} in ('failed', 'partial')`,
      ),
    )
    .returning({
      id: evalResponseScores.id,
      goldAnswer: evalResponseScores.goldAnswer,
      rubric: evalResponseScores.rubric,
      ratifiedBy: evalResponseScores.ratifiedBy,
    });

  if (!updated) {
    console.error(`No failed/partial scorable eval_response_scores row found for ${rowId}`);
    process.exit(1);
  }
  console.log(JSON.stringify(updated, null, 2));
}

type RatifiedRow = Awaited<ReturnType<typeof loadRatifiedRows>>[number];

async function loadRatifiedRows() {
  return db
    .select({
      score: evalResponseScores,
      trace: conversationTraces,
    })
    .from(evalResponseScores)
    .innerJoin(conversationTraces, eq(evalResponseScores.traceId, conversationTraces.id))
    .where(
      and(
        eq(evalResponseScores.scorable, true),
        sql`${evalResponseScores.verdict} in ('failed', 'partial')`,
        isNotNull(evalResponseScores.ratifiedBy),
        isNotNull(evalResponseScores.goldAnswer),
      ),
    )
    .orderBy(desc(evalResponseScores.createdAt));
}

async function loadTurnsForRow(row: RatifiedRow) {
  const traces = row.trace.threadTs
    ? await db
        .select()
        .from(conversationTraces)
        .where(
          and(
            sql`coalesce(${conversationTraces.channelId}, '') = ${row.trace.channelId ?? ""}`,
            eq(conversationTraces.threadTs, row.trace.threadTs),
          ),
        )
        .orderBy(asc(conversationTraces.createdAt))
    : [row.trace];

  const traceIds = traces.map((trace) => trace.id);
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

  if (messages.length === 0) return [];

  const parts = await db
    .select()
    .from(conversationParts)
    .where(
      and(
        inArray(
          conversationParts.messageId,
          messages.map((message) => message.id),
        ),
        inArray(conversationParts.type, ["text", "tool-invocation"]),
      ),
    )
    .orderBy(asc(conversationParts.orderIndex));

  return buildTurns(traces, messages, parts);
}

async function exportRatified() {
  const rows = await loadRatifiedRows();
  const cases = [];

  for (const row of rows) {
    const turns = await loadTurnsForRow(row);
    const targetIndex = turns.findIndex((turn) => turn.partId === row.score.partId);
    const history = targetIndex >= 0 ? turns.slice(0, targetIndex) : turns;
    let questionIndex = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "user") {
        questionIndex = i;
        break;
      }
    }

    const questionTurn = questionIndex >= 0 ? history[questionIndex] : null;
    const sessionTurns = history
      .filter((_, idx) => idx !== questionIndex)
      .map((turn) => ({
        role: turn.role,
        speaker: turn.role === "assistant" ? "Aura" : (turn.userId ?? "User"),
        content: turn.text,
      }));

    const question = questionTurn
      ? questionTurn.text
      : (row.score.servingIntent ?? "Provide the correct Aura response for the ratified eval case.");

    cases.push({
      id: `eval-response-${row.score.id}`,
      source: "eval_response",
      category: row.score.failureClass,
      question,
      goldAnswer: row.score.goldAnswer ?? "",
      abstention: false,
      sessions: [
        {
          id: row.trace.threadTs ?? row.trace.id,
          timestamp: row.trace.createdAt.toISOString(),
          turns: sessionTurns,
        },
      ],
      rubric: row.score.rubric,
      metadata: {
        evalResponseScoreId: row.score.id,
        verdict: row.score.verdict,
        failureClass: row.score.failureClass,
        servingIntent: row.score.servingIntent,
        ratifiedBy: row.score.ratifiedBy,
        threadLink: slackThreadLink(row.trace.channelId, row.score.threadTs),
      },
    });
  }

  process.stdout.write(`${JSON.stringify(cases, null, 2)}\n`);
}

if (hasFlag("list")) {
  await listQueue();
} else if (readFlag("ratify")) {
  await ratifyOne();
} else if (hasFlag("export")) {
  await exportRatified();
}
