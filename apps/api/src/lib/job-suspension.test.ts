import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  type Operation = {
    kind: "update";
    setArg?: Record<string, unknown>;
  };

  const state = {
    operations: [] as Operation[],
    failNext: false,
    update: vi.fn(),
  };

  function createQuery(operation: Operation) {
    const query: any = {
      set: vi.fn((setArg: Record<string, unknown>) => {
        operation.setArg = setArg;
        return query;
      }),
      where: vi.fn(() => query),
      then: (onFulfilled: any, onRejected: any) => {
        if (state.failNext) {
          state.failNext = false;
          return Promise.reject(new Error("db unavailable")).then(onFulfilled, onRejected);
        }
        state.operations.push(operation);
        return Promise.resolve([]).then(onFulfilled, onRejected);
      },
    };
    return query;
  }

  state.update.mockImplementation(() => createQuery({ kind: "update" }));

  return state;
});

vi.mock("../db/client.js", () => ({
  db: { update: dbMock.update },
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const NOW = new Date("2026-08-17T06:00:00.000Z");

describe("isSuspensionActive", () => {
  it("is false for null/undefined deadlines", async () => {
    const { isSuspensionActive } = await import("./job-suspension.js");
    expect(isSuspensionActive(null, NOW)).toBe(false);
    expect(isSuspensionActive(undefined, NOW)).toBe(false);
  });

  it("is true only while the deadline is in the future", async () => {
    const { isSuspensionActive } = await import("./job-suspension.js");
    expect(isSuspensionActive(new Date(NOW.getTime() + 1), NOW)).toBe(true);
    expect(isSuspensionActive(new Date(NOW.getTime()), NOW)).toBe(false);
    expect(isSuspensionActive(new Date(NOW.getTime() - 1), NOW)).toBe(false);
  });
});

describe("markJobSuspendedForDetachedCommand", () => {
  beforeEach(() => {
    dbMock.operations = [];
    dbMock.failNext = false;
    vi.clearAllMocks();
  });

  it("stamps suspendedUntil = now + SUSPENDED_JOB_TIMEOUT_MS on job and execution", async () => {
    const { markJobSuspendedForDetachedCommand, SUSPENDED_JOB_TIMEOUT_MS } = await import(
      "./job-suspension.js"
    );

    await markJobSuspendedForDetachedCommand({
      jobId: "job-1",
      jobExecutionId: "exec-1",
      commandId: "abcd1234",
      now: NOW,
    });

    const expectedDeadline = new Date(NOW.getTime() + SUSPENDED_JOB_TIMEOUT_MS);
    const sets = dbMock.operations.map((op) => op.setArg ?? {});
    expect(sets).toHaveLength(2);
    // jobs row: shield + freshness bump
    expect(sets[0]).toEqual({ suspendedUntil: expectedDeadline, updatedAt: NOW });
    // job_executions row: shield only
    expect(sets[1]).toEqual({ suspendedUntil: expectedDeadline });
  });

  it("skips tables whose ids are missing", async () => {
    const { markJobSuspendedForDetachedCommand } = await import("./job-suspension.js");

    await markJobSuspendedForDetachedCommand({
      jobId: null,
      jobExecutionId: "exec-1",
      commandId: "abcd1234",
      now: NOW,
    });

    expect(dbMock.operations).toHaveLength(1);
    expect(dbMock.operations[0].setArg).not.toHaveProperty("updatedAt");
  });

  it("never throws when the DB write fails", async () => {
    const { markJobSuspendedForDetachedCommand } = await import("./job-suspension.js");
    dbMock.failNext = true;

    await expect(
      markJobSuspendedForDetachedCommand({
        jobId: "job-1",
        jobExecutionId: null,
        commandId: "abcd1234",
        now: NOW,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("clearJobSuspension", () => {
  beforeEach(() => {
    dbMock.operations = [];
    dbMock.failNext = false;
    vi.clearAllMocks();
  });

  it("nulls suspendedUntil on the job", async () => {
    const { clearJobSuspension } = await import("./job-suspension.js");
    await clearJobSuspension("job-1");

    expect(dbMock.operations).toHaveLength(1);
    expect(dbMock.operations[0].setArg).toMatchObject({ suspendedUntil: null });
  });

  it("never throws when the DB write fails", async () => {
    const { clearJobSuspension } = await import("./job-suspension.js");
    dbMock.failNext = true;
    await expect(clearJobSuspension("job-1")).resolves.toBeUndefined();
  });
});
