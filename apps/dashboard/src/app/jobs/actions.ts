"use server";

import { db } from "@/lib/db";
import { jobs, jobExecutions, conversationTraces } from "@schema";
import { eq, desc, ilike, sql, inArray } from "drizzle-orm";
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
  let traceByExec: Record<string, { costUsd: string | null; traceId: string }> = {};
  if (execIds.length > 0) {
    const traceRows = await db
      .select({
        jobExecutionId: conversationTraces.jobExecutionId,
        costUsd: conversationTraces.costUsd,
        traceId: conversationTraces.id,
      })
      .from(conversationTraces)
      .where(inArray(conversationTraces.jobExecutionId, execIds));

    traceByExec = Object.fromEntries(
      traceRows
        .filter((r) => r.jobExecutionId != null)
        .map((r) => [r.jobExecutionId!, { costUsd: r.costUsd, traceId: r.traceId }]),
    );
  }

  const executionsWithTrace = executions.map((exec) => ({
    ...exec,
    costUsd: traceByExec[exec.id]?.costUsd ?? null,
    conversationTraceId: traceByExec[exec.id]?.traceId ?? null,
  }));

  return { job, executions: executionsWithTrace };
}

export async function toggleJobEnabled(id: string, enabled: boolean) {
  await db
    .update(jobs)
    .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
    .where(eq(jobs.id, id));
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
}
