"use server";

import { db } from "@/lib/db";
import {
  conversationTraces,
  conversationMessages,
  jobs,
  jobExecutions,
} from "@schema";
import { eq, desc, sql, and, type SQL } from "drizzle-orm";
import { fetchConversationWithParts } from "@/lib/queries";

export async function getConversations(
  sourceType?: string,
  search?: string,
  page = 1,
  limit = 25,
) {
  const offset = (page - 1) * limit;
  const conditions: SQL[] = [];

  if (sourceType && sourceType !== "all") {
    conditions.push(eq(conversationTraces.sourceType, sourceType));
  }

  if (search) {
    conditions.push(
      sql`(${conversationTraces.channelId} ILIKE ${"%" + search + "%"} OR ${conversationTraces.userId} ILIKE ${"%" + search + "%"})`,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ value: total }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(conversationTraces)
    .where(where);

  const traces = await db
    .select()
    .from(conversationTraces)
    .where(where)
    .orderBy(desc(conversationTraces.createdAt))
    .limit(limit)
    .offset(offset);

  const traceIds = traces.map((t) => t.id);

  let messageCounts: Record<string, number> = {};
  if (traceIds.length > 0) {
    const rows = await db
      .select({
        conversationId: conversationMessages.conversationId,
        count: sql<number>`count(*)::int`,
      })
      .from(conversationMessages)
      .where(sql`${conversationMessages.conversationId} IN ${traceIds}`)
      .groupBy(conversationMessages.conversationId);

    messageCounts = Object.fromEntries(rows.map((r) => [r.conversationId, r.count]));
  }

  const jobExecIds = traces
    .map((t) => t.jobExecutionId)
    .filter((id): id is string => id != null);

  let jobLabels: Record<string, string> = {};
  if (jobExecIds.length > 0) {
    const rows = await db
      .select({
        execId: jobExecutions.id,
        jobName: jobs.name,
      })
      .from(jobExecutions)
      .innerJoin(jobs, eq(jobs.id, jobExecutions.jobId))
      .where(sql`${jobExecutions.id} IN ${jobExecIds}`);

    jobLabels = Object.fromEntries(rows.map((r) => [r.execId, r.jobName]));
  }

  const items = traces.map((trace) => {
    const tokenUsage = trace.tokenUsage as {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    } | null;

    let sourceLabel: string;
    if (trace.sourceType === "job_execution" && trace.jobExecutionId) {
      sourceLabel = jobLabels[trace.jobExecutionId] ?? "Unknown job";
    } else {
      const parts = [trace.channelId, trace.userId].filter(Boolean);
      sourceLabel = parts.length > 0 ? parts.join(" / ") : "—";
    }

    return {
      ...trace,
      messageCount: messageCounts[trace.id] ?? 0,
      sourceLabel,
      tokenUsage,
      costUsd: trace.costUsd,
    };
  });

  return { items, total };
}

export async function getConversation(id: string) {
  const [trace] = await db
    .select()
    .from(conversationTraces)
    .where(eq(conversationTraces.id, id));
  if (!trace) return null;

  const conversation = await fetchConversationWithParts(trace.id);

  let jobName: string | null = null;
  let jobId: string | null = null;
  if (trace.jobExecutionId) {
    const [exec] = await db
      .select({ jobId: jobExecutions.jobId })
      .from(jobExecutions)
      .where(eq(jobExecutions.id, trace.jobExecutionId));
    if (exec?.jobId) {
      jobId = exec.jobId;
      const [job] = await db
        .select({ name: jobs.name })
        .from(jobs)
        .where(eq(jobs.id, exec.jobId));
      if (job) jobName = job.name;
    }
  }

  return {
    trace,
    conversation,
    jobName,
    jobId,
  };
}
