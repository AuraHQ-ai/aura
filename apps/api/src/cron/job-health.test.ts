import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  type Operation = {
    kind: "select";
  };

  const state = {
    results: [] as unknown[][],
    select: vi.fn(),
  };

  function nextResult() {
    return state.results.shift() ?? [];
  }

  function createQuery(operation: Operation) {
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: (onFulfilled: any, onRejected: any) => {
        void operation;
        return Promise.resolve(nextResult()).then(onFulfilled, onRejected);
      },
    };
    return query;
  }

  state.select.mockImplementation(() => createQuery({ kind: "select" }));

  return state;
});

const sendJobOpsNoticeMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, target: "ops_channel" as const })),
);

const settingsStore = vi.hoisted(() => ({
  values: {} as Record<string, string>,
}));

const getSettingMock = vi.hoisted(() =>
  vi.fn(async (key: string) => settingsStore.values[key] ?? null),
);

const setSettingMock = vi.hoisted(() =>
  vi.fn(async (key: string, value: string) => {
    settingsStore.values[key] = value;
  }),
);

vi.mock("../db/client.js", () => ({
  db: { select: dbMock.select },
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../lib/settings.js", () => ({
  getSetting: getSettingMock,
  setSetting: setSettingMock,
}));

vi.mock("./job-notifications.js", () => ({
  sendJobOpsNotice: sendJobOpsNoticeMock,
  truncateJobFailureText: (value: string | null | undefined, maxChars = 400) => {
    const text = value?.trim() || "unknown";
    return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
  },
}));

function queueDbResults(...results: unknown[][]) {
  dbMock.results = [...results];
}

const NOW = new Date("2026-08-17T06:00:00.000Z");

describe("evaluateJobHealth", () => {
  it("counts the leading run of consecutive failures (newest first)", async () => {
    const { evaluateJobHealth } = await import("./job-health.js");

    expect(evaluateJobHealth([]).consecutiveFailures).toBe(0);
    expect(evaluateJobHealth(["completed"]).consecutiveFailures).toBe(0);
    expect(evaluateJobHealth(["failed", "completed", "failed"]).consecutiveFailures).toBe(1);
    expect(
      evaluateJobHealth(["failed", "failed", "failed", "completed"]).consecutiveFailures,
    ).toBe(3);
  });

  it("a success at the head resets the consecutive count even after many failures", async () => {
    const { evaluateJobHealth } = await import("./job-health.js");
    expect(
      evaluateJobHealth(["completed", "failed", "failed", "failed"]).consecutiveFailures,
    ).toBe(0);
  });

  it("flags noSuccessInWindow only when the window is full and success-free", async () => {
    const { evaluateJobHealth } = await import("./job-health.js");

    // Window of 3 for testability.
    expect(evaluateJobHealth(["failed", "failed"], 3).noSuccessInWindow).toBe(false); // not enough history
    expect(evaluateJobHealth(["failed", "failed", "failed"], 3).noSuccessInWindow).toBe(true);
    expect(evaluateJobHealth(["failed", "completed", "failed"], 3).noSuccessInWindow).toBe(false);
    // Non-terminal statuses (e.g. interrupted) count as non-success.
    expect(evaluateJobHealth(["failed", "interrupted", "failed"], 3).noSuccessInWindow).toBe(true);
  });

  it("only looks at the most recent X runs for the window", async () => {
    const { evaluateJobHealth } = await import("./job-health.js");
    // The success is outside the window of 3 → still unhealthy.
    expect(
      evaluateJobHealth(["failed", "failed", "failed", "completed"], 3).noSuccessInWindow,
    ).toBe(true);
  });
});

describe("scanJobFailureHealth", () => {
  beforeEach(() => {
    dbMock.results = [];
    vi.clearAllMocks();
    sendJobOpsNoticeMock.mockResolvedValue({ ok: true, target: "ops_channel" });
  });

  it("returns zero counts and sends nothing when no fresh failures exist", async () => {
    queueDbResults([]); // fresh failures query

    const { scanJobFailureHealth } = await import("./job-health.js");
    await expect(scanJobFailureHealth(NOW)).resolves.toEqual({ scanned: 0, alerted: 0 });
    expect(sendJobOpsNoticeMock).not.toHaveBeenCalled();
  });

  it("alerts through the ops-notice plumbing when a job crosses the consecutive-failure threshold", async () => {
    queueDbResults(
      [{ jobId: "job-1" }], // fresh failures
      [{ id: "job-1", name: "sync-meta-comments-daily", requestedBy: "U_OWNER" }], // candidate jobs
      [
        { status: "failed", error: "Script hard failure (exit code 127)" },
        { status: "failed", error: "Script hard failure (exit code 127)" },
        { status: "failed", error: "Script hard failure (exit code 127)" },
        { status: "completed", error: null },
      ], // recent executions, newest first
    );

    const { scanJobFailureHealth } = await import("./job-health.js");
    const result = await scanJobFailureHealth(NOW);

    expect(result).toEqual({ scanned: 1, alerted: 1 });
    expect(sendJobOpsNoticeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        jobName: "sync-meta-comments-daily",
        requestedBy: "U_OWNER",
        text: expect.stringContaining("3 consecutive failed runs"),
        logContext: expect.objectContaining({ event: "job_health_alert" }),
      }),
    );
    expect(sendJobOpsNoticeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Script hard failure (exit code 127)"),
      }),
    );
  });

  it("does not alert when the streak is below the threshold and a recent success exists", async () => {
    queueDbResults(
      [{ jobId: "job-1" }],
      [{ id: "job-1", name: "flaky-but-fine", requestedBy: "U_OWNER" }],
      [
        { status: "failed", error: "transient timeout" },
        { status: "completed", error: null },
        { status: "failed", error: "transient timeout" },
        { status: "completed", error: null },
      ],
    );

    const { scanJobFailureHealth } = await import("./job-health.js");
    const result = await scanJobFailureHealth(NOW);

    expect(result).toEqual({ scanned: 1, alerted: 0 });
    expect(sendJobOpsNoticeMock).not.toHaveBeenCalled();
  });

  it("never throws when the DB query fails", async () => {
    dbMock.select.mockImplementationOnce(() => {
      throw new Error("db unavailable");
    });

    const { scanJobFailureHealth } = await import("./job-health.js");
    await expect(scanJobFailureHealth(NOW)).resolves.toEqual({ scanned: 0, alerted: 0 });
  });
});

function nullPromptJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-null",
    name: "docs-refresh",
    requestedBy: "aura",
    enabled: 1,
    cronSchedule: "0 9 * * 1-5",
    archivedAt: null,
    promptMode: null,
    ...overrides,
  };
}

describe("scanJobConfigHealth", () => {
  beforeEach(() => {
    dbMock.results = [];
    settingsStore.values = {};
    vi.clearAllMocks();
    sendJobOpsNoticeMock.mockResolvedValue({ ok: true, target: "ops_channel" });
  });

  it("reports and alerts when an enabled recurring job has NULL promptMode", async () => {
    queueDbResults([nullPromptJob()]);

    const { scanJobConfigHealth } = await import("./job-health.js");
    const result = await scanJobConfigHealth(NOW);

    expect(result).toEqual({
      found: 1,
      alerted: 1,
      jobNames: ["docs-refresh"],
    });
    expect(sendJobOpsNoticeMock).toHaveBeenCalledTimes(1);
    expect(sendJobOpsNoticeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(/NULL prompt_mode[\s\S]*full ~40k[\s\S]*update_job[\s\S]*`docs-refresh`/),
        logContext: expect.objectContaining({
          event: "job_config_health_null_prompt_mode",
        }),
      }),
    );
    expect(setSettingMock).toHaveBeenCalledWith(
      "job_config_health_last_notice_at",
      NOW.toISOString(),
      "job-config-health",
    );
  });

  it("returns nothing when every enabled recurring job already has promptMode set", async () => {
    queueDbResults([
      nullPromptJob({ name: "already-task", promptMode: "task" }),
      nullPromptJob({ id: "job-full", name: "already-full", promptMode: "full" }),
    ]);

    const { scanJobConfigHealth } = await import("./job-health.js");
    await expect(scanJobConfigHealth(NOW)).resolves.toEqual({
      found: 0,
      alerted: 0,
      jobNames: [],
    });
    expect(sendJobOpsNoticeMock).not.toHaveBeenCalled();
  });

  it("ignores disabled, one-shot, and archived jobs even when promptMode is NULL", async () => {
    queueDbResults([
      nullPromptJob(),
      nullPromptJob({ id: "job-off", name: "disabled-digest", enabled: 0 }),
      nullPromptJob({ id: "job-once", name: "one-shot", cronSchedule: null }),
      nullPromptJob({
        id: "job-arch",
        name: "archived-digest",
        archivedAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ]);

    const { scanJobConfigHealth } = await import("./job-health.js");
    const result = await scanJobConfigHealth(NOW);

    expect(result.found).toBe(1);
    expect(result.jobNames).toEqual(["docs-refresh"]);
    expect(sendJobOpsNoticeMock).toHaveBeenCalledTimes(1);
  });

  it("does not send a second notice within the 24h throttle window", async () => {
    const { scanJobConfigHealth } = await import("./job-health.js");

    queueDbResults([nullPromptJob()]);
    await expect(scanJobConfigHealth(NOW)).resolves.toMatchObject({
      found: 1,
      alerted: 1,
    });
    expect(sendJobOpsNoticeMock).toHaveBeenCalledTimes(1);

    queueDbResults([nullPromptJob()]);
    const laterSameDay = new Date(NOW.getTime() + 12 * 60 * 60 * 1000);
    await expect(scanJobConfigHealth(laterSameDay)).resolves.toEqual({
      found: 1,
      alerted: 0,
      jobNames: ["docs-refresh"],
    });
    expect(sendJobOpsNoticeMock).toHaveBeenCalledTimes(1);
  });

  it("never throws when the DB query fails", async () => {
    dbMock.select.mockImplementationOnce(() => {
      throw new Error("db unavailable");
    });

    const { scanJobConfigHealth } = await import("./job-health.js");
    await expect(scanJobConfigHealth(NOW)).resolves.toEqual({
      found: 0,
      alerted: 0,
      jobNames: [],
    });
  });
});

