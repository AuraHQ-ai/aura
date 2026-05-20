import { jobs } from "@aura/db/schema";
import { db } from "../../db/client.js";
import {
  DEFAULT_FOUNDER_USER_ID,
  RECURRING_JOB_HEALTH_MONITOR_SCRIPT,
} from "../health.js";

export const RECURRING_JOB_HEALTH_MONITOR_NAME =
  "recurring-job-health-monitor";

export const RECURRING_JOB_HEALTH_MONITOR_DESCRIPTION =
  "Daily survey of recurring job health. DMs founder if any recurring job has consecutive failures >= 3 OR days since last success >= 2 OR status=failed with enabled=true.";

export function getRecurringJobHealthMonitorSeed() {
  return {
    name: RECURRING_JOB_HEALTH_MONITOR_NAME,
    description: RECURRING_JOB_HEALTH_MONITOR_DESCRIPTION,
    playbook: null,
    script: RECURRING_JOB_HEALTH_MONITOR_SCRIPT,
    cronSchedule: "0 9 * * *",
    frequencyConfig: null,
    channelId: null,
    threadTs: null,
    executeAt: null,
    requestedBy: process.env.FOUNDER_USER_ID || DEFAULT_FOUNDER_USER_ID,
    priority: "normal",
    status: "pending",
    timezone: "Europe/Zurich",
    result: null,
    retries: 0,
    enabled: 1,
    requiredCredentialIds: [],
    updatedAt: new Date(),
  } satisfies typeof jobs.$inferInsert;
}

export async function seedRecurringJobHealthMonitor(): Promise<void> {
  const seed = getRecurringJobHealthMonitorSeed();

  await db
    .insert(jobs)
    .values(seed)
    .onConflictDoUpdate({
      target: [jobs.workspaceId, jobs.name],
      set: {
        description: seed.description,
        playbook: seed.playbook,
        script: seed.script,
        cronSchedule: seed.cronSchedule,
        frequencyConfig: seed.frequencyConfig,
        channelId: seed.channelId,
        threadTs: seed.threadTs,
        executeAt: seed.executeAt,
        requestedBy: seed.requestedBy,
        priority: seed.priority,
        status: seed.status,
        timezone: seed.timezone,
        retries: seed.retries,
        enabled: seed.enabled,
        requiredCredentialIds: seed.requiredCredentialIds,
        updatedAt: seed.updatedAt,
      },
    });
}
