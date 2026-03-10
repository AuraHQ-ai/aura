"use server";

import { db } from "@/lib/db";
import { messages, jobExecutions, jobs, userProfiles } from "@schema";
import { desc, sql, gte, eq, isNotNull } from "drizzle-orm";

export async function getConsumptionData() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const dailyUsage = await db
    .select({
      date: sql<string>`date_trunc('day', ${messages.createdAt})::date::text`.as("date"),
      totalInput: sql<number>`coalesce(sum((${messages.tokenUsage}->>'inputTokens')::int), 0)`.as("total_input"),
      totalOutput: sql<number>`coalesce(sum((${messages.tokenUsage}->>'outputTokens')::int), 0)`.as("total_output"),
      totalTokens: sql<number>`coalesce(sum((${messages.tokenUsage}->>'totalTokens')::int), 0)`.as("total_tokens"),
      messageCount: sql<number>`count(*)`.as("message_count"),
    })
    .from(messages)
    .where(sql`${messages.tokenUsage} IS NOT NULL AND ${messages.createdAt} >= ${thirtyDaysAgo}`)
    .groupBy(sql`date_trunc('day', ${messages.createdAt})::date`)
    .orderBy(sql`date_trunc('day', ${messages.createdAt})::date`);

  const perUser = await db
    .select({
      userId: messages.userId,
      displayName: userProfiles.displayName,
      totalTokens: sql<number>`coalesce(sum((${messages.tokenUsage}->>'totalTokens')::int), 0)`.as("total_tokens"),
      messageCount: sql<number>`count(*)`.as("message_count"),
    })
    .from(messages)
    .leftJoin(userProfiles, eq(messages.userId, userProfiles.slackUserId))
    .where(sql`${messages.tokenUsage} IS NOT NULL AND ${messages.createdAt} >= ${thirtyDaysAgo}`)
    .groupBy(messages.userId, userProfiles.displayName)
    .orderBy(desc(sql`total_tokens`))
    .limit(20);

  const perJob = await db
    .select({
      jobId: jobExecutions.jobId,
      jobName: jobs.name,
      totalTokens: sql<number>`coalesce(sum((${jobExecutions.tokenUsage}->>'totalTokens')::int), 0)`.as("total_tokens"),
      executionCount: sql<number>`count(*)`.as("execution_count"),
    })
    .from(jobExecutions)
    .leftJoin(jobs, eq(jobExecutions.jobId, jobs.id))
    .where(sql`${jobExecutions.tokenUsage} IS NOT NULL AND ${jobExecutions.startedAt} >= ${thirtyDaysAgo}`)
    .groupBy(jobExecutions.jobId, jobs.name)
    .orderBy(desc(sql`total_tokens`))
    .limit(20);

  const [totals] = await db
    .select({
      totalTokens: sql<number>`coalesce(sum((${messages.tokenUsage}->>'totalTokens')::int), 0)`.as("total_tokens"),
      totalMessages: sql<number>`count(*)`.as("total_messages"),
    })
    .from(messages)
    .where(sql`${messages.tokenUsage} IS NOT NULL AND ${messages.createdAt} >= ${thirtyDaysAgo}`);

  return {
    dailyUsage,
    perUser,
    perJob,
    totals: {
      totalTokens: totals.totalTokens || 0,
      totalMessages: totals.totalMessages || 0,
      avgDaily: dailyUsage.length > 0 ? Math.round((totals.totalTokens || 0) / dailyUsage.length) : 0,
    },
  };
}
