import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  db: dbMock,
}));

vi.mock("../lib/slack-messaging.js", () => ({
  safePostMessage: vi.fn(),
}));

vi.mock("../tools/slack.js", () => ({
  resolveSlackDestination: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

interface SeedJob {
  id: string;
  name: string;
  cron_schedule: string | null;
  status: string;
  enabled: number;
  requested_by: string;
}

interface SeedExecution {
  job_id: string;
  status: "completed" | "failed" | "running";
  started_at: Date;
  finished_at: Date | null;
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function buildSqlRows(
  jobs: SeedJob[],
  executions: SeedExecution[],
  now: Date,
) {
  return jobs
    .filter((job) => job.enabled === 1 && job.cron_schedule)
    .map((job) => {
      const jobExecutions = executions.filter((execution) => execution.job_id === job.id);
      const completed = jobExecutions.filter(
        (execution) => execution.status === "completed" && execution.finished_at,
      );
      const lastSuccessfulRun =
        completed.length === 0
          ? null
          : completed.reduce<Date | null>((latest, execution) => {
              if (!execution.finished_at) return latest;
              if (!latest || execution.finished_at > latest) return execution.finished_at;
              return latest;
            }, null);
      const consecutiveFailures = jobExecutions.filter(
        (execution) =>
          execution.status === "failed" &&
          execution.started_at > (lastSuccessfulRun ?? new Date("1970-01-01T00:00:00Z")),
      ).length;

      return {
        id: job.id,
        name: job.name,
        cron_schedule: job.cron_schedule,
        status: job.status,
        enabled: job.enabled,
        requested_by: job.requested_by,
        last_successful_run: lastSuccessfulRun,
        consecutive_failures: consecutiveFailures,
        days_since_last_success: lastSuccessfulRun
          ? (now.getTime() - lastSuccessfulRun.getTime()) / (24 * 60 * 60 * 1000)
          : null,
      };
    });
}

describe("getRecurringJobHealth", () => {
  const now = new Date("2026-05-20T09:00:00Z");
  const founder = "U0678NQJ2";

  beforeEach(() => {
    dbMock.execute.mockReset();
  });

  it("flags slow-rot failures and leaves healthy/no-execution recurring jobs unflagged", async () => {
    const seedJobs: SeedJob[] = [
      {
        id: "healthy",
        name: "healthy-daily",
        cron_schedule: "0 8 * * *",
        status: "pending",
        enabled: 1,
        requested_by: founder,
      },
      {
        id: "eleven-day-failing",
        name: "sync-meta-comments-daily",
        cron_schedule: "0 8 * * *",
        status: "failed",
        enabled: 1,
        requested_by: founder,
      },
      {
        id: "three-consec",
        name: "three-consec-failure-job",
        cron_schedule: "0 7 * * *",
        status: "pending",
        enabled: 1,
        requested_by: founder,
      },
      {
        id: "no-execution",
        name: "new-recurring-job",
        cron_schedule: "0 10 * * *",
        status: "pending",
        enabled: 1,
        requested_by: founder,
      },
    ];
    const seedExecutions: SeedExecution[] = [
      {
        job_id: "healthy",
        status: "completed",
        started_at: daysAgo(now, 0.2),
        finished_at: daysAgo(now, 0.2),
      },
      {
        job_id: "eleven-day-failing",
        status: "completed",
        started_at: daysAgo(now, 12),
        finished_at: daysAgo(now, 12),
      },
      ...Array.from({ length: 11 }, (_, index) => ({
        job_id: "eleven-day-failing",
        status: "failed" as const,
        started_at: daysAgo(now, 11 - index),
        finished_at: daysAgo(now, 11 - index),
      })),
      {
        job_id: "three-consec",
        status: "completed",
        started_at: daysAgo(now, 1),
        finished_at: daysAgo(now, 1),
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        job_id: "three-consec",
        status: "failed" as const,
        started_at: daysAgo(now, 0.75 - index * 0.1),
        finished_at: daysAgo(now, 0.75 - index * 0.1),
      })),
    ];

    dbMock.execute.mockResolvedValue({
      rows: buildSqlRows(seedJobs, seedExecutions, now),
    });

    const { getRecurringJobHealth } = await import("./health.js");
    const rows = await getRecurringJobHealth();
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));

    expect(byName["healthy-daily"].isFlagged).toBe(false);
    expect(byName["new-recurring-job"].isFlagged).toBe(false);

    expect(byName["sync-meta-comments-daily"].isFlagged).toBe(true);
    expect(byName["sync-meta-comments-daily"].consecutiveFailures).toBe(11);
    expect(byName["sync-meta-comments-daily"].flagReasons).toEqual(
      expect.arrayContaining([
        "11 consecutive failures",
        "12 days since last success",
        "enabled job status is failed",
      ]),
    );

    expect(byName["three-consec-failure-job"].isFlagged).toBe(true);
    expect(byName["three-consec-failure-job"].consecutiveFailures).toBe(3);
    expect(byName["three-consec-failure-job"].flagReasons).toContain(
      "3 consecutive failures",
    );
  });
});
