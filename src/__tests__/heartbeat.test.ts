import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isRecurringJobDue } from "../cron/heartbeat.js";

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    name: "test-job",
    description: "test",
    playbook: null,
    cronSchedule: null,
    frequencyConfig: null,
    channelId: null,
    threadTs: null,
    executeAt: null,
    requestedBy: "aura",
    priority: "normal",
    status: "pending",
    timezone: "UTC",
    result: null,
    retries: 0,
    lastExecutedAt: null,
    lastResult: null,
    executionCount: 0,
    todayExecutions: 0,
    lastExecutionDate: null,
    enabled: 1,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  } as any;
}

describe("isRecurringJobDue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("job with every-minute cron and no lastExecutedAt is due if createdAt is old enough", () => {
    vi.setSystemTime(new Date("2025-06-15T12:05:00Z"));
    const job = makeJob({
      cronSchedule: "* * * * *",
      createdAt: new Date("2025-06-15T12:00:00Z"),
    });
    expect(isRecurringJobDue(job)).toBe(true);
  });

  it("job with lastExecutedAt after the last cron tick should NOT be due", () => {
    vi.setSystemTime(new Date("2025-06-15T12:05:30Z"));
    const job = makeJob({
      cronSchedule: "* * * * *",
      createdAt: new Date("2025-06-15T12:00:00Z"),
      lastExecutedAt: new Date("2025-06-15T12:05:00Z"),
    });
    expect(isRecurringJobDue(job)).toBe(false);
  });

  it("job with invalid cron should return false (not throw)", () => {
    vi.setSystemTime(new Date("2025-06-15T12:05:00Z"));
    const job = makeJob({
      cronSchedule: "not a valid cron",
      createdAt: new Date("2025-06-15T12:00:00Z"),
    });
    expect(isRecurringJobDue(job)).toBe(false);
  });

  it("job with no cronSchedule and no frequencyConfig returns true", () => {
    vi.setSystemTime(new Date("2025-06-15T12:05:00Z"));
    const job = makeJob({
      cronSchedule: null,
      frequencyConfig: null,
    });
    expect(isRecurringJobDue(job)).toBe(true);
  });
});
