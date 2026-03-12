"use server";

import { db } from "@/lib/db";
import { jobs, jobExecutions, jobExecutionMessages, jobExecutionParts } from "@schema";
import { eq, desc, asc, ilike, sql } from "drizzle-orm";
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

  return { job, executions };
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

  const msgs = await db
    .select()
    .from(jobExecutionMessages)
    .where(eq(jobExecutionMessages.executionId, execId))
    .orderBy(asc(jobExecutionMessages.orderIndex));

  const msgIds = msgs.map((m) => m.id);
  let parts: (typeof jobExecutionParts.$inferSelect)[] = [];
  if (msgIds.length > 0) {
    parts = await db
      .select()
      .from(jobExecutionParts)
      .where(sql`${jobExecutionParts.messageId} IN ${msgIds}`)
      .orderBy(asc(jobExecutionParts.orderIndex));
  }

  const conversation = msgs.map((msg) => ({
    ...msg,
    parts: parts.filter((p) => p.messageId === msg.id),
  }));

  return { execution: exec, conversation };
}

export async function toggleJobEnabled(id: string, enabled: boolean) {
  await db
    .update(jobs)
    .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
    .where(eq(jobs.id, id));
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
}
