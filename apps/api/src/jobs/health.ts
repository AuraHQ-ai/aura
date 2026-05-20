import { sql } from "drizzle-orm";
import type { WebClient } from "@slack/web-api";
import { db } from "../db/client.js";
import { settings } from "@aura/db/schema";
import { safePostMessage } from "../lib/slack-messaging.js";
import { resolveSlackDestination } from "../tools/slack.js";
import { logger } from "../lib/logger.js";

export const DEFAULT_FOUNDER_USER_ID = "U0678NQJ2";
export const RECURRING_JOB_HEALTH_MONITOR_SCRIPT =
  "internal:recurring-job-health-monitor";

const HEALTH_TIMEZONE = "Europe/Zurich";
const DAILY_DM_SETTING_PREFIX = "recurring_job_health:last_dm";

export interface JobHealthRow {
  id: string;
  name: string;
  cronSchedule: string;
  status: string;
  enabled: boolean;
  requestedBy: string;
  lastSuccessfulRun: Date | null;
  consecutiveFailures: number;
  daysSinceLastSuccess: number | null;
  isFlagged: boolean;
  flagReasons: string[];
}

interface RawJobHealthRow {
  id: string;
  name: string;
  cron_schedule: string | null;
  status: string;
  enabled: boolean | number | string;
  requested_by: string;
  last_successful_run: Date | string | null;
  consecutive_failures: number | string | null;
  days_since_last_success: number | string | null;
}

function extractRows(result: unknown): RawJobHealthRow[] {
  return ((result as any).rows ?? result) as RawJobHealthRow[];
}

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseEnabled(value: boolean | number | string): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function flagReasonsFor(row: {
  status: string;
  enabled: boolean;
  consecutiveFailures: number;
  daysSinceLastSuccess: number | null;
}): string[] {
  const reasons: string[] = [];

  if (row.consecutiveFailures >= 3) {
    reasons.push(`${row.consecutiveFailures} consecutive failures`);
  }
  if (row.daysSinceLastSuccess != null && row.daysSinceLastSuccess >= 2) {
    reasons.push(`${formatDays(row.daysSinceLastSuccess)} days since last success`);
  }
  if (row.status === "failed" && row.enabled) {
    reasons.push("enabled job status is failed");
  }

  return reasons;
}

export function normalizeJobHealthRows(rows: RawJobHealthRow[]): JobHealthRow[] {
  return rows.map((row) => {
    const enabled = parseEnabled(row.enabled);
    const consecutiveFailures = parseNumber(row.consecutive_failures) ?? 0;
    const daysSinceLastSuccess = parseNumber(row.days_since_last_success);
    const lastSuccessfulRun = parseDate(row.last_successful_run);
    const normalized = {
      id: row.id,
      name: row.name,
      cronSchedule: row.cron_schedule ?? "",
      status: row.status,
      enabled,
      requestedBy: row.requested_by,
      lastSuccessfulRun,
      consecutiveFailures,
      daysSinceLastSuccess,
    };
    const flagReasons = flagReasonsFor(normalized);

    return {
      ...normalized,
      isFlagged: flagReasons.length > 0,
      flagReasons,
    };
  });
}

export async function getRecurringJobHealth(): Promise<JobHealthRow[]> {
  const result = await db.execute(sql`
    WITH last_success AS (
      SELECT job_id, MAX(finished_at) AS last_successful_run
      FROM job_executions
      WHERE status = 'completed'
      GROUP BY job_id
    ),
    consec_fails AS (
      SELECT je.job_id,
             COUNT(*) FILTER (
               WHERE je.status = 'failed'
                 AND je.started_at > COALESCE(ls.last_successful_run, '1970-01-01'::timestamptz)
             ) AS consecutive_failures
      FROM job_executions je
      LEFT JOIN last_success ls ON ls.job_id = je.job_id
      GROUP BY je.job_id
    )
    SELECT j.id,
           j.name,
           j.cron_schedule,
           j.status,
           j.enabled,
           j.requested_by,
           ls.last_successful_run,
           COALESCE(cf.consecutive_failures, 0) AS consecutive_failures,
           EXTRACT(EPOCH FROM (NOW() - ls.last_successful_run)) / 86400 AS days_since_last_success
    FROM jobs j
    LEFT JOIN last_success ls ON ls.job_id = j.id
    LEFT JOIN consec_fails cf ON cf.job_id = j.id
    WHERE j.enabled = 1
      AND j.cron_schedule IS NOT NULL
      AND j.cron_schedule != ''
    ORDER BY
      CASE WHEN j.status = 'failed' THEN 0 ELSE 1 END,
      COALESCE(cf.consecutive_failures, 0) DESC,
      ls.last_successful_run ASC NULLS FIRST,
      j.name ASC
  `);

  return normalizeJobHealthRows(extractRows(result));
}

function localDateKey(date: Date, timezone = HEALTH_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function formatDateTime(date: Date | null): string {
  if (!date) return "never";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: HEALTH_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}`;
}

function formatDays(days: number): string {
  return days >= 10 ? days.toFixed(0) : days.toFixed(1);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function formatSlackTable(rows: JobHealthRow[]): string {
  const headers = ["Job", "Last Success", "Fails", "Days", "Status", "Cron"];
  const body = rows.map((row) => [
    truncate(row.name, 34),
    formatDateTime(row.lastSuccessfulRun),
    String(row.consecutiveFailures),
    row.daysSinceLastSuccess == null ? "n/a" : formatDays(row.daysSinceLastSuccess),
    row.status,
    truncate(row.cronSchedule, 18),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...body.map((row) => row[index].length)),
  );
  const formatRow = (row: string[]) =>
    row.map((cell, index) => cell.padEnd(widths[index])).join(" | ");

  return [
    formatRow(headers),
    widths.map((width) => "-".repeat(width)).join("-|-"),
    ...body.map(formatRow),
  ].join("\n");
}

export function formatRecurringJobHealthMessage(
  rows: JobHealthRow[],
  now = new Date(),
): string {
  const flagged = rows.filter((row) => row.isFlagged);
  const date = localDateKey(now);
  const reasonLines = flagged.map(
    (row) => `- *${row.name}*: ${row.flagReasons.join("; ")}`,
  );

  return [
    `*Recurring job health alert* (${date})`,
    "",
    `${flagged.length} of ${rows.length} enabled recurring jobs need attention.`,
    "",
    "```",
    formatSlackTable(flagged),
    "```",
    "",
    "*Why these were flagged*",
    ...reasonLines,
  ].join("\n");
}

function notificationSettingKey(founderUserId: string, dateKey: string): string {
  return `${DAILY_DM_SETTING_PREFIX}:${founderUserId}:${dateKey}`;
}

async function claimDailyFounderNotification(
  founderUserId: string,
  dateKey: string,
  flaggedRows: JobHealthRow[],
): Promise<boolean> {
  const key = notificationSettingKey(founderUserId, dateKey);
  const value = JSON.stringify({
    notifiedAt: new Date().toISOString(),
    flaggedJobIds: flaggedRows.map((row) => row.id),
  });

  const inserted = await db
    .insert(settings)
    .values({
      key,
      value,
      updatedBy: RECURRING_JOB_HEALTH_MONITOR_SCRIPT,
      updatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ key: settings.key });

  return inserted.length > 0;
}

export async function runRecurringJobHealthMonitor(options?: {
  founderUserId?: string;
  slackClient?: WebClient;
  now?: Date;
}): Promise<string> {
  const founderUserId =
    options?.founderUserId || process.env.FOUNDER_USER_ID || DEFAULT_FOUNDER_USER_ID;
  const now = options?.now ?? new Date();
  const rows = await getRecurringJobHealth();
  const flaggedRows = rows.filter((row) => row.isFlagged);

  if (flaggedRows.length === 0) {
    return `Recurring job health: all ${rows.length} enabled recurring jobs are healthy.`;
  }

  const dateKey = localDateKey(now);
  const claimed = await claimDailyFounderNotification(founderUserId, dateKey, flaggedRows);
  if (!claimed) {
    return `Recurring job health: ${flaggedRows.length} job(s) need attention; skipped duplicate DM for ${founderUserId} on ${dateKey}.`;
  }

  let client = options?.slackClient;
  if (!client) {
    const { WebClient } = await import("@slack/web-api");
    client = new WebClient(process.env.SLACK_BOT_TOKEN || "");
  }
  const dmChannelId = await resolveSlackDestination(client, founderUserId);

  if (!dmChannelId) {
    throw new Error(`Could not open Slack DM for founder ${founderUserId}`);
  }

  const message = formatRecurringJobHealthMessage(rows, now);
  const postResult = await safePostMessage(client, {
    channel: dmChannelId,
    text: message,
    unfurl_links: false,
    unfurl_media: false,
  });

  if (!postResult.ok) {
    throw new Error(`Slack rejected recurring job health DM for ${founderUserId}`);
  }

  logger.warn("Recurring job health monitor sent alert", {
    founderUserId,
    flaggedJobs: flaggedRows.map((row) => row.name),
  });

  return `Recurring job health: sent ${flaggedRows.length} flagged job(s) to ${founderUserId}.`;
}
