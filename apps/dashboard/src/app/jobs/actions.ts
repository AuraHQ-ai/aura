"use server";

import { db } from "@/lib/db";
import { jobs, jobExecutions } from "@schema";
import { eq, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getJobs() {
  return db
    .select()
    .from(jobs)
    .orderBy(desc(jobs.updatedAt))
    .limit(200);
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

export async function toggleJobEnabled(id: string, enabled: boolean) {
  await db
    .update(jobs)
    .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
    .where(eq(jobs.id, id));
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
}
