"use server";

import { db } from "@/lib/db";
import { messages, jobExecutions, jobs, userProfiles } from "@schema";
import { desc, sql, eq } from "drizzle-orm";

const emptyResult = {
  dailyUsage: [] as { date: string; totalInput: number; totalOutput: number; totalTokens: number; messageCount: number }[],
  perUser: [] as { userId: string; displayName: string | null; totalTokens: number; messageCount: number }[],
  perJob: [] as { jobId: string | null; jobName: string | null; totalTokens: number; executionCount: number }[],
  totals: { totalTokens: 0, totalMessages: 0, avgDaily: 0 },
};

export async function getConsumptionData() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  try {
    const dailyUsage = await db
      .select({
        date: sql<string>`date_trunc('day', ${messages.createdAt})::date::text`.as("date"),
        totalInput: sql<number>`coalesce(sum(("token_usage"->>'inputTokens')::int), 0)`.as("total_input"),
        totalOutput: sql<number>`coalesce(sum(("token_usage"->>'outputTokens')::int), 0)`.as("total_output"),
        totalTokens: sql<number>`coalesce(sum(("token_usage"->>'totalTokens')::int), 0)`.as("total_tokens"),
        messageCount: sql<number>`count(*)`.as("message_count"),
      })
      .from(messages)
      .where(sql`"token_usage" IS NOT NULL AND ${messages.createdAt} >= ${thirtyDaysAgo}`)
      .groupBy(sql`date_trunc('day', ${messages.createdAt})::date`)
      .orderBy(sql`date_trunc('day', ${messages.createdAt})::date`);

    const perUser = await db
      .select({
        userId: messages.userId,
        displayName: userProfiles.displayName,
        totalTokens: sql<number>`coalesce(sum(("token_usage"->>'totalTokens')::int), 0)`.as("total_tokens"),
        messageCount: sql<number>`count(*)`.as("message_count"),
      })
      .from(messages)
      .leftJoin(userProfiles, eq(messages.userId, userProfiles.slackUserId))
      .where(sql`"token_usage" IS NOT NULL AND ${messages.createdAt} >= ${thirtyDaysAgo}`)
      .groupBy(messages.userId, userProfiles.displayName)
      .orderBy(desc(sql`total_tokens`))
      .limit(20);

    const perJob = await db
      .select({
        jobId: jobExecutions.jobId,
        jobName: jobs.name,
        totalTokens: sql<number>`coalesce(sum(("token_usage"->>'totalTokens')::int), 0)`.as("total_tokens"),
        executionCount: sql<number>`count(*)`.as("execution_count"),
      })
      .from(jobExecutions)
      .leftJoin(jobs, eq(jobExecutions.jobId, jobs.id))
      .where(sql`"token_usage" IS NOT NULL AND ${jobExecutions.startedAt} >= ${thirtyDaysAgo}`)
      .groupBy(jobExecutions.jobId, jobs.name)
      .orderBy(desc(sql`total_tokens`))
      .limit(20);

    const [totals] = await db
      .select({
        totalTokens: sql<number>`coalesce(sum(("token_usage"->>'totalTokens')::int), 0)`.as("total_tokens"),
        totalMessages: sql<number>`count(*)`.as("total_messages"),
      })
      .from(messages)
      .where(sql`"token_usage" IS NOT NULL AND ${messages.createdAt} >= ${thirtyDaysAgo}`);

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
  } catch {
    return emptyResult;
  }
}
