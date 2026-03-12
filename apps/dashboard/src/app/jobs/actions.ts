"use server";

import { db } from "@/lib/db";
import { jobs, jobExecutions, conversationTraces } from "@schema";
import { eq, desc, ilike, sql, inArray } from "drizzle-orm";
import { fetchConversationWithParts } from "@/lib/queries";
import { revalidatePath } from "next/cache";

export async function getJobs(search?: string, page = 1, limit = 100) {
  const offset = (page - 1) * limit;
  const where = search ? ilike(jobs.name, `%${search}%`) : undefined;

  const [{ value: total }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(jobs)
    .where(where);

  const items = await db
    .select()
    .from(jobs)
    .where(where)
    .orderBy(desc(jobs.updatedAt))
    .limit(limit)
    .offset(offset);

  return { items, total };
}

export async function getJob(id: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!job) return null;

  const executions = await db
    .select()
    .from(jobExecutions)
    .where(eq(jobExecutions.jobId, id))
    .orderBy(desc(jobExecutions.startedAt))
    .limit(50);

  const execIds = executions.map((e) => e.id);
  let execCosts: Record<string, string | null> = {};
  if (execIds.length > 0) {
    const costRows = await db
      .select({
        jobExecutionId: conversationTraces.jobExecutionId,
        costUsd: conversationTraces.costUsd,
      })
      .from(conversationTraces)
      .where(inArray(conversationTraces.jobExecutionId, execIds));

    execCosts = Object.fromEntries(
      costRows
        .filter((r) => r.jobExecutionId != null)
        .map((r) => [r.jobExecutionId!, r.costUsd]),
    );
  }

  const executionsWithCost = executions.map((exec) => ({
    ...exec,
    costUsd: execCosts[exec.id] ?? null,
  }));

  return { job, executions: executionsWithCost };
}

export async function getExecution(execId: string) {
  const [exec] = await db.select().from(jobExecutions).where(eq(jobExecutions.id, execId));
  return exec ?? null;
}

export async function getExecutionWithConversation(execId: string) {
  const [exec] = await db
    .select()
    .from(jobExecutions)
    .where(eq(jobExecutions.id, execId));
  if (!exec) return null;

  // Find conversation trace for this execution
  const [trace] = await db
    .select()
    .from(conversationTraces)
    .where(eq(conversationTraces.jobExecutionId, execId))
    .limit(1);

  if (!trace) return { execution: exec, conversation: [], conversationTraceId: null, costUsd: null };

  const conversation = await fetchConversationWithParts(trace.id);

  return { execution: exec, conversation, conversationTraceId: trace.id, costUsd: trace.costUsd };
}

export async function toggleJobEnabled(id: string, enabled: boolean) {
  await db
    .update(jobs)
    .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
    .where(eq(jobs.id, id));
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
}
