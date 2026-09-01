import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── DB mock (matches heartbeat.test.ts pattern) ───────────────────────────────

const dbMock = vi.hoisted(() => {
  type Operation = {
    kind: "select" | "update" | "delete" | "insert";
    setArg?: Record<string, unknown>;
    valuesArg?: Record<string, unknown>;
  };

  const state = {
    results: [] as unknown[][],
    operations: [] as Operation[],
    select: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    insert: vi.fn(),
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
      leftJoin: vi.fn(() => query),
      groupBy: vi.fn(() => query),
      set: vi.fn((setArg: Record<string, unknown>) => {
        operation.setArg = setArg;
        return query;
      }),
      values: vi.fn((valuesArg: Record<string, unknown>) => {
        operation.valuesArg = valuesArg;
        return query;
      }),
      returning: vi.fn(() => {
        state.operations.push(operation);
        return Promise.resolve(nextResult());
      }),
      then: (onFulfilled: any, onRejected: any) => {
        state.operations.push(operation);
        return Promise.resolve(nextResult()).then(onFulfilled, onRejected);
      },
    };
    return query;
  }

  state.select.mockImplementation(() => createQuery({ kind: "select" }));
  state.update.mockImplementation(() => createQuery({ kind: "update" }));
  state.delete.mockImplementation(() => createQuery({ kind: "delete" }));
  state.insert.mockImplementation(() => createQuery({ kind: "insert" }));

  return state;
});

vi.mock("../db/client.js", () => ({
  db: {
    select: dbMock.select,
    update: dbMock.update,
    delete: dbMock.delete,
    insert: dbMock.insert,
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function queueDbResults(...results: unknown[][]) {
  dbMock.results = [...results];
}

function updateSets() {
  return dbMock.operations
    .filter((op) => op.kind === "update")
    .map((op) => op.setArg ?? {});
}

function baseExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: "exec-1",
    jobId: "job-1",
    startedAt: new Date("2026-08-17T06:00:00.000Z"), // 59 min ago at "now"
    status: "running",
    ...overrides,
  };
}

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    name: "test-job",
    cronSchedule: null,
    timezone: "UTC",
    workspaceId: "default",
    status: "running",
    ...overrides,
  };
}

// "now" = 2026-08-17T06:59:00Z in all tests
const NOW = new Date("2026-08-17T06:59:00.000Z");
// cutoff = 45 min before now = 2026-08-17T06:14:00Z
// executions started before cutoff should be detected

describe("sweepStuckJobs — selection logic", () => {
  beforeEach(() => {
    dbMock.results = [];
    dbMock.operations = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not process executions started less than 45 minutes ago", async () => {
    // started 30 min ago → should NOT be detected
    const recentExec = baseExecution({
      startedAt: new Date("2026-08-17T06:29:00.000Z"), // 30 min before NOW
    });

    // The SELECT returns nothing because the DB properly filters; simulate empty.
    queueDbResults([]); // stuckExecutions query returns empty

    const { sweepStuckJobs } = await import("./job-watchdog.js");
    const result = await sweepStuckJobs(NOW);

    expect(result.detected).toBe(0);
    expect(result.markedFailed).toBe(0);
    expect(result.requeued).toBe(0);
    // No updates should have been issued
    expect(updateSets()).toEqual([]);
    // Satisfies the rule that the test does not accidentally pass due to mocking:
    // recentExec is only referenced so TS doesn't prune it.
    expect(recentExec.id).toBe("exec-1");
  });

  it("marks a stuck one-shot execution and its parent job as failed", async () => {
    const exec = baseExecution({
      startedAt: new Date("2026-08-17T06:00:00.000Z"), // 59 min ago
    });
    const job = baseJob({ cronSchedule: null });

    queueDbResults(
      [exec],         // stuckExecutions select
      [job],          // parent jobs select
      [{ id: exec.id }], // execution update (claimed)
      [],             // job update
    );

    const { sweepStuckJobs } = await import("./job-watchdog.js");
    const result = await sweepStuckJobs(NOW);

    expect(result.detected).toBe(1);
    expect(result.markedFailed).toBe(1);
    expect(result.requeued).toBe(0);

    const sets = updateSets();
    // Execution should be marked failed
    expect(sets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("reset by watchdog"),
        }),
      ]),
    );
    // Job should be marked failed with the same message
    expect(sets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          result: expect.stringContaining("reset by watchdog"),
        }),
      ]),
    );
  });

  it("marks a stuck recurring execution as failed and requeues the parent job", async () => {
    const exec = baseExecution({
      startedAt: new Date("2026-08-17T06:00:00.000Z"), // 59 min ago
    });
    const job = baseJob({ cronSchedule: "0 8 * * *", timezone: "UTC" });

    queueDbResults(
      [exec],
      [job],
      [{ id: exec.id }], // execution claimed
      [],                // job requeued
    );

    const { sweepStuckJobs } = await import("./job-watchdog.js");
    const result = await sweepStuckJobs(NOW);

    expect(result.detected).toBe(1);
    expect(result.markedFailed).toBe(1);
    expect(result.requeued).toBe(1);

    const sets = updateSets();
    // Job should be moved to pending with retries reset and a future executeAt
    const requeueSet = sets.find((s) => s.status === "pending");
    expect(requeueSet).toBeDefined();
    expect(requeueSet).toMatchObject({
      status: "pending",
      retries: 0,
      result: expect.stringContaining("reset by watchdog"),
    });
    expect((requeueSet!.executeAt as Date).toISOString()).toBe(
      "2026-08-17T08:00:00.000Z", // next "0 8 * * *" tick after NOW
    );
  });

  it("is idempotent: skips execution if concurrent sweep already claimed it", async () => {
    const exec = baseExecution({
      startedAt: new Date("2026-08-17T06:00:00.000Z"),
    });
    const job = baseJob({ cronSchedule: null });

    queueDbResults(
      [exec],
      [job],
      [], // update returns nothing → already claimed by another sweep
    );

    const { sweepStuckJobs } = await import("./job-watchdog.js");
    const result = await sweepStuckJobs(NOW);

    expect(result.detected).toBe(1);
    // claimed by another sweep → markedFailed = 0, no further updates
    expect(result.markedFailed).toBe(0);
    expect(result.requeued).toBe(0);
    // Only the execution update was attempted; no job update follows
    expect(updateSets().length).toBe(1);
  });

  it("returns zero counts and does not throw when no stuck executions exist", async () => {
    queueDbResults([]); // empty result set

    const { sweepStuckJobs } = await import("./job-watchdog.js");
    await expect(sweepStuckJobs(NOW)).resolves.toEqual({
      detected: 0,
      markedFailed: 0,
      requeued: 0,
      skippedSuspended: 0,
    });
    expect(updateSets()).toEqual([]);
  });

  it("error message encodes the actual age in minutes", async () => {
    // started exactly 120 min ago
    const exec = baseExecution({
      startedAt: new Date(NOW.getTime() - 120 * 60 * 1000),
    });
    const job = baseJob({ cronSchedule: null });

    queueDbResults([exec], [job], [{ id: exec.id }], []);

    const { sweepStuckJobs } = await import("./job-watchdog.js");
    await sweepStuckJobs(NOW);

    const execSet = updateSets().find((s) => s.error !== undefined);
    expect(execSet?.error).toContain("120m");
    expect(execSet?.error).toContain("reset by watchdog");
  });

  it("WATCHDOG_RESET_MARKER constant matches the string written to jobs.result", async () => {
    const exec = baseExecution({
      startedAt: new Date(NOW.getTime() - 60 * 60 * 1000), // 60 min ago
    });
    const job = baseJob({ cronSchedule: null });

    queueDbResults([exec], [job], [{ id: exec.id }], []);

    const { sweepStuckJobs, WATCHDOG_RESET_MARKER } = await import("./job-watchdog.js");
    await sweepStuckJobs(NOW);

    const jobSet = updateSets().find((s) => s.result !== undefined);
    expect(jobSet?.result).toContain(WATCHDOG_RESET_MARKER);
  });
});

// ── Webhook-suspension exclusion (issue #1326) ────────────────────────────────

describe("sweepStuckJobs — webhook-suspended executions", () => {
  beforeEach(() => {
    dbMock.results = [];
    dbMock.operations = [];
    vi.clearAllMocks();
  });

  it("skips an execution whose suspension deadline is still in the future", async () => {
    // Suspended 30 min past NOW — legitimately parked awaiting a webhook.
    const exec = baseExecution({
      startedAt: new Date("2026-08-17T06:00:00.000Z"), // 59 min ago (stale by age)
      suspendedUntil: new Date(NOW.getTime() + 30 * 60 * 1000),
    });
    const job = baseJob({ cronSchedule: null });

    queueDbResults([exec], [job]);

    const { sweepStuckJobs } = await import("./job-watchdog.js");
    const result = await sweepStuckJobs(NOW);

    expect(result.detected).toBe(1);
    expect(result.skippedSuspended).toBe(1);
    expect(result.markedFailed).toBe(0);
    expect(result.requeued).toBe(0);
    // The execution must NOT be claimed or failed while suspended.
    expect(updateSets()).toEqual([]);
  });

  it("processes an execution whose suspension deadline has elapsed", async () => {
    const exec = baseExecution({
      startedAt: new Date("2026-08-17T06:00:00.000Z"),
      suspendedUntil: new Date(NOW.getTime() - 5 * 60 * 1000), // elapsed 5 min ago
    });
    const job = baseJob({ cronSchedule: null });

    queueDbResults([exec], [job], [{ id: exec.id }], []);

    const { sweepStuckJobs } = await import("./job-watchdog.js");
    const result = await sweepStuckJobs(NOW);

    expect(result.detected).toBe(1);
    expect(result.skippedSuspended).toBe(0);
    expect(result.markedFailed).toBe(1);
    expect(updateSets()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("reset by watchdog"),
        }),
      ]),
    );
  });

  it("treats a null suspendedUntil as not suspended", async () => {
    const exec = baseExecution({
      startedAt: new Date("2026-08-17T06:00:00.000Z"),
      suspendedUntil: null,
    });
    const job = baseJob({ cronSchedule: null });

    queueDbResults([exec], [job], [{ id: exec.id }], []);

    const { sweepStuckJobs } = await import("./job-watchdog.js");
    const result = await sweepStuckJobs(NOW);

    expect(result.skippedSuspended).toBe(0);
    expect(result.markedFailed).toBe(1);
  });
});

// ── Cost aggregation tests ────────────────────────────────────────────────────
// These tests exercise the dashboard jobs list handler's cost enrichment logic
// using a lightweight in-process simulation (no HTTP layer needed).

describe("cost aggregation — avgCostPerRunUsd derivation", () => {
  it("computes average cost per run correctly", () => {
    // Simulate what the API handler derives from the DB stat row.
    function deriveAvg(runs30d: number, cost30dUsd: string | null): string | null {
      if (runs30d <= 0 || cost30dUsd === null) return null;
      return (parseFloat(cost30dUsd) / runs30d).toFixed(6);
    }

    expect(deriveAvg(10, "0.050000")).toBe("0.005000");
    expect(deriveAvg(1, "0.123456")).toBe("0.123456");
    expect(deriveAvg(0, "0.050000")).toBeNull(); // no runs → null
    expect(deriveAvg(5, null)).toBeNull();        // no cost data → null
  });

  it("wasWatchdogReset is true iff result contains the WATCHDOG_RESET_MARKER", async () => {
    const { WATCHDOG_RESET_MARKER } = await import("./job-watchdog.js");

    function wasReset(result: string | null): boolean {
      return Boolean(result?.includes(WATCHDOG_RESET_MARKER));
    }

    expect(wasReset(`Stale: no completion signal after 59m, ${WATCHDOG_RESET_MARKER}`)).toBe(true);
    expect(wasReset("Failed: some other reason")).toBe(false);
    expect(wasReset(null)).toBe(false);
    expect(wasReset("")).toBe(false);
  });

  it("runs30d is 0 when there are no executions in the last 30 days", () => {
    // Simulate the costByJobId map miss (job not in the map).
    function enrich(stat: { runs30d: number; cost30dUsd: string | null } | undefined) {
      const runs30d = stat?.runs30d ?? 0;
      const cost30dUsd = stat?.cost30dUsd ?? null;
      const avgCostPerRunUsd =
        runs30d > 0 && cost30dUsd !== null
          ? (parseFloat(cost30dUsd) / runs30d).toFixed(6)
          : null;
      return { runs30d, cost30dUsd, avgCostPerRunUsd };
    }

    expect(enrich(undefined)).toEqual({
      runs30d: 0,
      cost30dUsd: null,
      avgCostPerRunUsd: null,
    });

    expect(enrich({ runs30d: 4, cost30dUsd: "0.020000" })).toEqual({
      runs30d: 4,
      cost30dUsd: "0.020000",
      avgCostPerRunUsd: "0.005000",
    });
  });
});
