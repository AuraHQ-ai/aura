/**
 * Topic-pivot probe for #1038 (last-message weighting).
 *
 * The standard LongMemEval / LoCoMo harness feeds the retriever a single
 * question string, so it never exercises the last-5-message join that causes
 * topic-pivot dilution in production (eval-retrieval.ts passes
 * `benchCase.question` verbatim). This probe reproduces the production seam: a
 * multi-turn query whose prior context is about topic A and whose LAST turn
 * pivots to topic B. It then compares retrieval quality between:
 *
 *   - plain   : embed(full last-5 join)                 — the old behaviour
 *   - weighted: embedWeightedQuery(latest, full join)   — #1038
 *
 * Acceptance (epic #1): the weighted query returns >= 2 on-topic (topic B)
 * memories in the top-15.
 *
 * Run it on demand (needs DB + embedding gateway):
 *   pnpm --filter aura-api exec tsx bench/scripts/topic-pivot-probe.ts
 *
 * It seeds an isolated, idempotent bench workspace and wipes its memories
 * before each run, so it never touches production data.
 */

import { db } from "../../src/db/client.js";
import { sql } from "drizzle-orm";
import { memories, type NewMemory } from "@aura/db/schema";
import { embedText, embedWeightedQuery } from "../../src/lib/embeddings.js";
import { retrieveMemories } from "../../src/memory/retrieve.js";
import {
  localBenchWorkspaceId,
  ensureBenchWorkspace,
  wipeBenchMemories,
} from "../src/workspace.js";

const TOPIC_A = "office-kitchen";
const TOPIC_B = "q3-churn";

// Topic B (the pivot target) — what the last turn actually asks about.
const TOPIC_B_MEMORIES = [
  "The team decided to prioritize reducing Q3 churn by shipping the renewal-reminder email sequence.",
  "Q3 churn was driven mainly by enterprise accounts not renewing after their annual contract lapsed.",
  "We agreed to offer a 15% loyalty discount to at-risk accounts to curb Q3 churn renewals.",
  "Renewal owners must reach out 60 days before contract end to lower Q3 churn.",
  "The churn dashboard now tracks renewal rate week-over-week for the Q3 cohort.",
];

// Topic A (the prior-context distractor) — must NOT crowd out topic B.
const TOPIC_A_MEMORIES = [
  "The office kitchen is restocked with oat milk every Monday morning.",
  "We switched the coffee supplier to a local roaster for the office kitchen.",
  "Someone keeps leaving dirty mugs in the office kitchen sink.",
  "The office kitchen now has a new espresso machine on the counter.",
  "Snack budget for the office kitchen was increased this quarter.",
];

// Prior conversation context is all about topic A; the LAST turn pivots to B.
const PRIOR_CONTEXT = [
  "Did we ever sort out the oat milk situation in the kitchen?",
  "Yeah, it's restocked Mondays now. And the new espresso machine is great.",
  "Nice. Someone still leaves mugs in the sink though.",
];
const LATEST_TURN =
  "Anyway — what did we actually decide about Q3 churn renewals?";

function topicMemoryRows(workspaceId: string): NewMemory[] {
  const mk = (content: string, topic: string): NewMemory => ({
    workspaceId,
    content,
    type: "decision",
    category: "semantic",
    sourceChannelType: "public_channel",
    sourceChannelId: `probe-${topic}`,
    relatedUserIds: [],
    searchVector: content,
    relevanceScore: 1,
    shareable: 1,
  });
  return [
    ...TOPIC_B_MEMORIES.map((c) => mk(c, TOPIC_B)),
    ...TOPIC_A_MEMORIES.map((c) => mk(c, TOPIC_A)),
  ];
}

function isTopicB(content: string): boolean {
  return /churn|renewal|q3/i.test(content);
}

async function seed(workspaceId: string, rows: NewMemory[]): Promise<void> {
  // Embed all contents in one batch, then insert with embeddings.
  const withEmbeddings = await Promise.all(
    rows.map(async (r) => ({
      ...r,
      embedding: await embedText(r.content),
    })),
  );
  await db.insert(memories).values(withEmbeddings);
}

async function countTopicBInTopK(
  workspaceId: string,
  queryText: string,
  queryEmbedding: number[],
  k = 15,
): Promise<{ topicB: number; total: number; preview: string[] }> {
  const results = await retrieveMemories({
    query: queryText,
    queryEmbedding,
    currentUserId: "probe:user",
    limit: k,
    workspaceId,
    adminMode: true,
    prefilter: true,
  });
  const topicB = results.filter((m) => isTopicB(m.content)).length;
  return {
    topicB,
    total: results.length,
    preview: results.slice(0, 8).map((m) => `${isTopicB(m.content) ? "B" : "A"}  ${m.content.slice(0, 70)}`),
  };
}

async function main(): Promise<void> {
  const workspaceId = localBenchWorkspaceId("topic-pivot");
  await ensureBenchWorkspace(workspaceId);
  await wipeBenchMemories(workspaceId);
  await seed(workspaceId, topicMemoryRows(workspaceId));

  const fullJoin = [...PRIOR_CONTEXT, LATEST_TURN].join("\n");
  const [plainEmb, weightedEmb] = await Promise.all([
    embedText(fullJoin),
    embedWeightedQuery(LATEST_TURN, fullJoin),
  ]);

  const plain = await countTopicBInTopK(workspaceId, fullJoin, plainEmb);
  const weighted = await countTopicBInTopK(workspaceId, fullJoin, weightedEmb);

  console.log("\n=== Topic-pivot probe (#1038) ===");
  console.log(`workspace: ${workspaceId}`);
  console.log(`\nquery (last-5 join):\n${fullJoin}\n`);
  console.log(`PLAIN    embed(full join)        → topic-B in top-${plain.total}: ${plain.topicB}`);
  for (const line of plain.preview) console.log(`   ${line}`);
  console.log(`\nWEIGHTED embedWeightedQuery(...) → topic-B in top-${weighted.total}: ${weighted.topicB}`);
  for (const line of weighted.preview) console.log(`   ${line}`);

  await wipeBenchMemories(workspaceId);

  const pass = weighted.topicB >= 2 && weighted.topicB >= plain.topicB;
  console.log(
    `\n${pass ? "PASS" : "FAIL"}: weighted topic-B=${weighted.topicB} (>=2 required), plain topic-B=${plain.topicB}`,
  );
  if (!pass) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.execute(sql`SELECT 1`).catch(() => {});
    process.exit(process.exitCode ?? 0);
  });
