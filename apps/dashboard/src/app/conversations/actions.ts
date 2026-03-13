"use server";

import { db } from "@/lib/db";
import {
  conversationTraces,
  conversationMessages,
  jobs,
  jobExecutions,
  userProfiles,
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
  let cumulativeTokens: Record<string, { inputTokens: number; outputTokens: number; totalTokens: number }> = {};
  let firstUserMessages: Record<string, string> = {};
  if (traceIds.length > 0) {
    const rows = await db
      .select({
        conversationId: conversationMessages.conversationId,
        count: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum((token_usage->>'inputTokens')::int), 0)::int`,
        outputTokens: sql<number>`coalesce(sum((token_usage->>'outputTokens')::int), 0)::int`,
        totalTokens: sql<number>`coalesce(sum((token_usage->>'totalTokens')::int), 0)::int`,
      })
      .from(conversationMessages)
      .where(sql`${conversationMessages.conversationId} IN ${traceIds}`)
      .groupBy(conversationMessages.conversationId);

    messageCounts = Object.fromEntries(rows.map((r) => [r.conversationId, r.count]));
    cumulativeTokens = Object.fromEntries(rows.map((r) => [r.conversationId, {
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      totalTokens: r.totalTokens,
    }]));

    const previewRows = await db
      .select({
        conversationId: conversationMessages.conversationId,
        content: conversationMessages.content,
      })
      .from(conversationMessages)
      .where(
        sql`${conversationMessages.conversationId} IN ${traceIds} AND ${conversationMessages.role} = 'user'`,
      )
      .orderBy(conversationMessages.orderIndex);

    for (const row of previewRows) {
      if (!firstUserMessages[row.conversationId] && row.content) {
        firstUserMessages[row.conversationId] = row.content;
      }
    }
  }

  const userIds = [...new Set(traces.map((t) => t.userId).filter(Boolean))] as string[];
  let userNames: Record<string, string> = {};
  if (userIds.length > 0) {
    const profileRows = await db
      .select({
        slackUserId: userProfiles.slackUserId,
        displayName: userProfiles.displayName,
      })
      .from(userProfiles)
      .where(sql`${userProfiles.slackUserId} IN ${userIds}`);

    userNames = Object.fromEntries(profileRows.map((r) => [r.slackUserId, r.displayName]));
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
    const traceTokenUsage = trace.tokenUsage as {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    } | null;

    const cumulative = cumulativeTokens[trace.id];
    const tokenUsage = cumulative && cumulative.totalTokens > 0
      ? cumulative
      : traceTokenUsage;

    let sourceLabel: string;
    if (trace.sourceType === "job_execution" && trace.jobExecutionId) {
      sourceLabel = jobLabels[trace.jobExecutionId] ?? "Unknown job";
    } else {
      const parts = [trace.channelId, trace.userId].filter(Boolean);
      sourceLabel = parts.length > 0 ? parts.join(" / ") : "—";
    }

    const resolvedName = trace.userId ? userNames[trace.userId] ?? null : null;
    const messagePreview = firstUserMessages[trace.id] ?? null;

    return {
      ...trace,
      messageCount: messageCounts[trace.id] ?? 0,
      sourceLabel,
      tokenUsage,
      costUsd: trace.costUsd,
      resolvedName,
      messagePreview,
    };
  });

  return { items, total };
}

export interface ThreadRow {
  channelId: string;
  threadTs: string;
  traceCount: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  firstTraceAt: Date;
  lastTraceAt: Date;
  userId: string | null;
  resolvedName: string | null;
  messagePreview: string | null;
  firstTraceId: string;
  sourceType: string;
}

export async function getThreads(
  sourceType?: string,
  search?: string,
  page = 1,
  limit = 25,
) {
  const offset = (page - 1) * limit;
  const conditions: SQL[] = [];

  conditions.push(sql`${conversationTraces.channelId} IS NOT NULL`);
  conditions.push(sql`${conversationTraces.threadTs} IS NOT NULL`);

  if (sourceType && sourceType !== "all") {
    conditions.push(eq(conversationTraces.sourceType, sourceType));
  }

  if (search) {
    conditions.push(
      sql`(${conversationTraces.channelId} ILIKE ${"%" + search + "%"} OR ${conversationTraces.userId} ILIKE ${"%" + search + "%"})`,
    );
  }

  const where = and(...conditions);

  const [{ value: total }] = await db
    .select({
      value: sql<number>`count(*)::int`,
    })
    .from(
      sql`(SELECT 1 FROM ${conversationTraces} WHERE ${where} GROUP BY ${conversationTraces.channelId}, ${conversationTraces.threadTs}) AS grouped`,
    );

  const threadRows = await db
    .select({
      channelId: conversationTraces.channelId,
      threadTs: conversationTraces.threadTs,
      traceCount: sql<number>`count(*)::int`,
      totalCostUsd: sql<number>`coalesce(sum(${conversationTraces.costUsd}::numeric), 0)::float`,
      firstTraceAt: sql<Date>`min(${conversationTraces.createdAt})`,
      lastTraceAt: sql<Date>`max(${conversationTraces.createdAt})`,
      firstTraceId: sql<string>`(array_agg(${conversationTraces.id} ORDER BY ${conversationTraces.createdAt} ASC))[1]`,
      userId: sql<string | null>`(array_agg(${conversationTraces.userId} ORDER BY ${conversationTraces.createdAt} ASC))[1]`,
      sourceType: sql<string>`(array_agg(${conversationTraces.sourceType} ORDER BY ${conversationTraces.createdAt} ASC))[1]`,
    })
    .from(conversationTraces)
    .where(where)
    .groupBy(conversationTraces.channelId, conversationTraces.threadTs)
    .orderBy(sql`max(${conversationTraces.createdAt}) DESC`)
    .limit(limit)
    .offset(offset);

  const firstTraceIds = threadRows.map((t) => t.firstTraceId).filter(Boolean);
  let firstUserMessages: Record<string, string> = {};
  if (firstTraceIds.length > 0) {
    const previewRows = await db
      .select({
        conversationId: conversationMessages.conversationId,
        content: conversationMessages.content,
      })
      .from(conversationMessages)
      .where(
        sql`${conversationMessages.conversationId} IN ${firstTraceIds} AND ${conversationMessages.role} = 'user'`,
      )
      .orderBy(conversationMessages.orderIndex);

    for (const row of previewRows) {
      if (!firstUserMessages[row.conversationId] && row.content) {
        firstUserMessages[row.conversationId] = row.content;
      }
    }
  }

  const allTraceIds = threadRows.map((t) => t.firstTraceId).filter(Boolean);
  const allChannelThreadKeys = threadRows.map(
    (t) => `${t.channelId}::${t.threadTs}`,
  );

  let threadTokens: Record<string, { inputTokens: number; outputTokens: number; totalTokens: number }> = {};
  if (allChannelThreadKeys.length > 0) {
    const tokenRows = await db
      .select({
        channelId: conversationTraces.channelId,
        threadTs: conversationTraces.threadTs,
        inputTokens: sql<number>`coalesce(sum((${conversationMessages.tokenUsage}->>'inputTokens')::int), 0)::int`,
        outputTokens: sql<number>`coalesce(sum((${conversationMessages.tokenUsage}->>'outputTokens')::int), 0)::int`,
        totalTokens: sql<number>`coalesce(sum((${conversationMessages.tokenUsage}->>'totalTokens')::int), 0)::int`,
      })
      .from(conversationMessages)
      .innerJoin(
        conversationTraces,
        eq(conversationMessages.conversationId, conversationTraces.id),
      )
      .where(
        sql`${conversationTraces.channelId} IS NOT NULL AND ${conversationTraces.threadTs} IS NOT NULL AND concat(${conversationTraces.channelId}, '::', ${conversationTraces.threadTs}) IN ${allChannelThreadKeys}`,
      )
      .groupBy(conversationTraces.channelId, conversationTraces.threadTs);

    for (const row of tokenRows) {
      const key = `${row.channelId}::${row.threadTs}`;
      threadTokens[key] = {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
      };
    }
  }

  const userIds = [...new Set(threadRows.map((t) => t.userId).filter(Boolean))] as string[];
  let userNames: Record<string, string> = {};
  if (userIds.length > 0) {
    const profileRows = await db
      .select({
        slackUserId: userProfiles.slackUserId,
        displayName: userProfiles.displayName,
      })
      .from(userProfiles)
      .where(sql`${userProfiles.slackUserId} IN ${userIds}`);

    userNames = Object.fromEntries(profileRows.map((r) => [r.slackUserId, r.displayName]));
  }

  const items: ThreadRow[] = threadRows.map((row) => {
    const key = `${row.channelId}::${row.threadTs}`;
    const tokens = threadTokens[key] ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    return {
      channelId: row.channelId!,
      threadTs: row.threadTs!,
      traceCount: row.traceCount,
      totalCostUsd: row.totalCostUsd,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      totalTokens: tokens.totalTokens,
      firstTraceAt: row.firstTraceAt,
      lastTraceAt: row.lastTraceAt,
      userId: row.userId,
      resolvedName: row.userId ? userNames[row.userId] ?? null : null,
      messagePreview: firstUserMessages[row.firstTraceId] ?? null,
      firstTraceId: row.firstTraceId,
      sourceType: row.sourceType,
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

  // Compute cumulative tokens from all assistant messages (sum of all steps).
  // The trace-level tokenUsage may only reflect the last step for older conversations.
  const [cumulative] = await db
    .select({
      inputTokens: sql<number>`coalesce(sum((token_usage->>'inputTokens')::int), 0)::int`,
      outputTokens: sql<number>`coalesce(sum((token_usage->>'outputTokens')::int), 0)::int`,
      totalTokens: sql<number>`coalesce(sum((token_usage->>'totalTokens')::int), 0)::int`,
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, id));

  // Override trace tokenUsage with cumulative if available
  if (cumulative && cumulative.totalTokens > 0) {
    (trace as any).tokenUsage = {
      ...((trace.tokenUsage as any) ?? {}),
      inputTokens: cumulative.inputTokens,
      outputTokens: cumulative.outputTokens,
      totalTokens: cumulative.totalTokens,
    };
  }

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
