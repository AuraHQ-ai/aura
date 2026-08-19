import { desc, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import {
  conversationMessages,
  conversationTraces,
} from "@aura/db/schema";
import { computeConversationCost } from "../src/lib/cost-calculator.js";

async function main() {
  const samples = await db.execute(sql`
    select distinct on (split_part(ct.model_id, '/', 1))
      split_part(ct.model_id, '/', 1) as provider,
      ct.id as trace_id,
      ct.model_id as trace_model_id,
      ct.resolved_model_id as trace_resolved_model_id,
      ct.cost_usd,
      cm.model_id as message_model_id,
      cm.resolved_model_id as message_resolved_model_id
    from conversation_traces ct
    join conversation_messages cm
      on cm.conversation_id = ct.id
     and cm.role = 'assistant'
    where ct.model_id is not null
      and ct.cost_usd is not null
    order by split_part(ct.model_id, '/', 1), ct.created_at desc, cm.order_index asc
  `);

  const providerSummary = await db.execute(sql`
    select
      split_part(model_id, '/', 1) as provider,
      count(*)::int as traces,
      sum(case when cost_usd is not null then 1 else 0 end)::int as priced_traces,
      sum(case when cost_usd is not null and cost_usd::numeric > 0 then 1 else 0 end)::int as non_zero_costs
    from conversation_traces
    where model_id is not null
    group by 1
    order by 1
  `);

  const sampleModels = [
    "openai/gpt-5.2",
    "google/gemini-3.1-flash-lite-preview",
    "xai/grok-4.20-reasoning",
    "zai/glm-5.1",
  ] as const;

  const activePricing = await db.execute(sql`
    select distinct model_id
    from model_pricing
    where effective_until is null
      and model_id in (${sql.join(sampleModels.map((modelId) => sql`${modelId}`), sql`, `)})
    order by model_id
  `);

  const sampleCostChecks = [];
  for (const row of activePricing.rows as Array<{ model_id: string }>) {
    const cost = await computeConversationCost(
      [
        {
          modelId: row.model_id,
          usage: {
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 1500,
          },
        },
      ],
      new Date(),
      "default",
    );

    sampleCostChecks.push({
      modelId: row.model_id,
      costUsd: cost,
    });
  }

  console.log(
    JSON.stringify(
      {
        samples,
        providerSummary,
        sampleCostChecks,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
