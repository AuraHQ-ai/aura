import { and, asc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { db } from "../src/db/client.js";
import {
  conversationMessages,
  conversationTraces,
  type DetailedTokenUsage,
} from "@aura/db/schema";
import {
  computeConversationCost,
  type StepUsage,
} from "../src/lib/cost-calculator.js";
import { syncModelCatalogFromGateway } from "../src/lib/model-catalog.js";

const BATCH_SIZE = 100;

async function main() {
  let lastTraceId = "";
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  const syncedAtByWorkspace = new Map<string, Date>();

  for (;;) {
    const traceFilter = lastTraceId
      ? and(
          isNotNull(conversationTraces.modelId),
          gt(conversationTraces.id, lastTraceId),
        )
      : isNotNull(conversationTraces.modelId);

    const traces = await db
      .select()
      .from(conversationTraces)
      .where(traceFilter)
      .orderBy(asc(conversationTraces.id))
      .limit(BATCH_SIZE);

    if (traces.length === 0) break;

    for (const trace of traces) {
      processed++;
      lastTraceId = trace.id;

      const workspaceId = trace.workspaceId ?? "default";
      if (!syncedAtByWorkspace.has(workspaceId)) {
        const syncResult = await syncModelCatalogFromGateway(workspaceId);
        syncedAtByWorkspace.set(workspaceId, syncResult.syncedAt);
      }

      if (processed % BATCH_SIZE === 0) {
        console.log(
          JSON.stringify({ processed, updated, skipped, lastTraceId }),
        );
      }
    }

    const traceIds = traces.map((trace) => trace.id);
    const assistantMessages = await db
      .select()
      .from(conversationMessages)
      .where(
        and(
          inArray(conversationMessages.conversationId, traceIds),
          eq(conversationMessages.role, "assistant"),
          isNotNull(conversationMessages.modelId),
          isNotNull(conversationMessages.tokenUsage),
        ),
      )
      .orderBy(
        asc(conversationMessages.conversationId),
        asc(conversationMessages.orderIndex),
      );

    const messagesByTraceId = new Map<string, typeof assistantMessages>();
    for (const message of assistantMessages) {
      const bucket = messagesByTraceId.get(message.conversationId) ?? [];
      bucket.push(message);
      messagesByTraceId.set(message.conversationId, bucket);
    }

    for (const trace of traces) {
      const traceMessages = messagesByTraceId.get(trace.id) ?? [];
      const stepUsages: StepUsage[] = traceMessages
        .filter(
          (
            message,
          ): message is typeof message & {
            modelId: string;
            tokenUsage: DetailedTokenUsage;
          } => message.modelId != null && message.tokenUsage != null,
        )
        .map((message) => ({
          modelId: message.modelId,
          resolvedModelId: message.resolvedModelId ?? undefined,
          usage: message.tokenUsage,
        }));

      const workspaceId = trace.workspaceId ?? "default";
      const pricedAt = syncedAtByWorkspace.get(workspaceId) ?? new Date();

      const fallbackTraceUsage =
        stepUsages.length === 0 &&
        trace.modelId != null &&
        trace.tokenUsage != null
          ? [
              {
                modelId: trace.modelId,
                resolvedModelId: trace.resolvedModelId ?? undefined,
                usage: trace.tokenUsage,
              } satisfies StepUsage,
            ]
          : [];

      const usagesToPrice = stepUsages.length > 0 ? stepUsages : fallbackTraceUsage;

      if (usagesToPrice.length === 0) {
        if (trace.sourceType === "job_execution") {
          await db
            .update(conversationTraces)
            .set({
              costUsd: trace.costUsd ?? "0.000000",
              costPricedAt: trace.costPricedAt ?? pricedAt,
              resolvedModelId: trace.resolvedModelId ?? null,
            })
            .where(eq(conversationTraces.id, trace.id));
          updated++;
          continue;
        }

        skipped++;
        continue;
      }

      const cost = await computeConversationCost(usagesToPrice, pricedAt, workspaceId);
      const firstResolvedModelId =
        traceMessages[0]?.resolvedModelId
        ?? trace.resolvedModelId
        ?? null;

      await db
        .update(conversationTraces)
        .set({
          costUsd: cost > 0 ? cost.toFixed(6) : trace.costUsd,
          costPricedAt: cost > 0 ? pricedAt : trace.costPricedAt,
          resolvedModelId: firstResolvedModelId,
        })
        .where(eq(conversationTraces.id, trace.id));

      updated++;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        processed,
        updated,
        skipped,
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
