import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  type Operation = {
    kind: "select" | "update";
    setArg?: Record<string, unknown>;
  };

  const state = {
    results: [] as unknown[][],
    operations: [] as Operation[],
    select: vi.fn(),
    update: vi.fn(),
  };

  function nextResult() {
    return state.results.shift() ?? [];
  }

  function createQuery(operation: Operation) {
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      limit: vi.fn(() => {
        state.operations.push(operation);
        return Promise.resolve(nextResult());
      }),
      set: vi.fn((setArg: Record<string, unknown>) => {
        operation.setArg = setArg;
        return query;
      }),
      returning: vi.fn(() => {
        state.operations.push(operation);
        return Promise.resolve(nextResult());
      }),
      // Queries awaited without .returning()/.limit() (e.g. the issue #1326
      // suspension-clear update) still record their operation.
      then: (onFulfilled: any, onRejected: any) => {
        state.operations.push(operation);
        return Promise.resolve(nextResult()).then(onFulfilled, onRejected);
      },
    };
    return query;
  }

  state.select.mockImplementation(() => createQuery({ kind: "select" }));
  state.update.mockImplementation(() => createQuery({ kind: "update" }));

  return state;
});

const logErrorMock = vi.hoisted(() => vi.fn());
const safePostMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../db/client.js", () => ({
  db: {
    select: dbMock.select,
    update: dbMock.update,
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

vi.mock("../lib/error-logger.js", () => ({
  logError: logErrorMock,
}));

vi.mock("../lib/slack-messaging.js", () => ({
  safePostMessage: safePostMessageMock,
}));

import {
  sweepStaleDetachedCommands,
  detachedCommandWatchdogStaleMs,
  DETACHED_COMMAND_NEVER_RESUMED_ERROR_CODE,
  DETACHED_COMMAND_RECOVERY_MESSAGE,
  DETACHED_COMMAND_WATCHDOG_NOTE,
} from "./detached-command-watchdog.js";
import { logger } from "../lib/logger.js";

const NOW = new Date("2026-08-03T12:00:00.000Z");

function staleCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: "abcdef12",
    workspaceId: "default",
    pid: 4321,
    command: "node scripts/write-blog-post.mjs --weekly",
    status: "running",
    exitCode: null,
    requestedBy: "U123",
    channelId: null,
    threadTs: null,
    jobId: "job-uuid-1",
    jobExecutionId: "exec-uuid-1",
    startedAt: new Date(NOW.getTime() - 45 * 60 * 1000),
    completedAt: null,
    stdoutTail: null,
    stderrTail: null,
    ...overrides,
  };
}

function queueDbResults(...results: unknown[][]) {
  dbMock.results = [...results];
}

function updateSets() {
  return dbMock.operations
    .filter((operation) => operation.kind === "update")
    .map((operation) => operation.setArg ?? {});
}

const slackClient = {} as any;

describe("detached command watchdog sweep", () => {
  const originalStaleMinutes = process.env.DETACHED_WATCHDOG_STALE_MINUTES;

  beforeEach(() => {
    dbMock.results = [];
    dbMock.operations = [];
    vi.clearAllMocks();
    safePostMessageMock.mockResolvedValue({ ok: true });
    delete process.env.DETACHED_WATCHDOG_STALE_MINUTES;
  });

  afterEach(() => {
    if (originalStaleMinutes === undefined) {
      delete process.env.DETACHED_WATCHDOG_STALE_MINUTES;
    } else {
      process.env.DETACHED_WATCHDOG_STALE_MINUTES = originalStaleMinutes;
    }
  });

  it("marks a stale running command failed with an error row and watchdog note", async () => {
    queueDbResults(
      [staleCommand()], // stale running commands
      [{ id: "abcdef12" }], // atomic claim succeeds
      [{ id: "exec-uuid-1" }], // job execution flipped to failed
    );

    const result = await sweepStaleDetachedCommands(slackClient, NOW);

    expect(result).toEqual({
      detected: 1,
      failed: 1,
      jobExecutionsFailed: 1,
      recoveryPosted: 0,
    });

    expect(updateSets()).toEqual([
      expect.objectContaining({
        status: "failed",
        completedAt: expect.any(Date),
        stderrTail: DETACHED_COMMAND_WATCHDOG_NOTE,
      }),
      expect.objectContaining({
        status: "failed",
        finishedAt: expect.any(Date),
        error: "detached command abcdef12 never resumed (webhook continuation lost)",
      }),
      // Suspension shield dropped (issue #1326) so the heartbeat stale sweep
      // can recover the parent job immediately.
      expect.objectContaining({
        suspendedUntil: null,
      }),
    ]);

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorName: "DetachedCommandNeverResumed",
        errorCode: DETACHED_COMMAND_NEVER_RESUMED_ERROR_CODE,
        userId: "U123",
        context: expect.objectContaining({
          id: "abcdef12",
          command: "node scripts/write-blog-post.mjs --weekly",
          jobId: "job-uuid-1",
          jobExecutionId: "exec-uuid-1",
          ageMs: 45 * 60 * 1000,
          recovered_by: "heartbeat",
        }),
      }),
    );
  });

  it("truncates the command to 100 chars in the error context", async () => {
    const longCommand = "x".repeat(250);
    queueDbResults(
      [staleCommand({ command: longCommand, jobExecutionId: null })],
      [{ id: "abcdef12" }],
    );

    await sweepStaleDetachedCommands(slackClient, NOW);

    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ command: "x".repeat(100) }),
      }),
    );
  });

  it("is idempotent: a failed command no longer matches the next sweep", async () => {
    queueDbResults([staleCommand()], [{ id: "abcdef12" }], [{ id: "exec-uuid-1" }]);
    await sweepStaleDetachedCommands(slackClient, NOW);
    expect(logErrorMock).toHaveBeenCalledTimes(1);

    // Second sweep: the status = 'running' filter no longer matches, so the
    // select returns nothing and no side effects fire.
    queueDbResults([]);
    const second = await sweepStaleDetachedCommands(slackClient, NOW);

    expect(second).toEqual({
      detected: 0,
      failed: 0,
      jobExecutionsFailed: 0,
      recoveryPosted: 0,
    });
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(safePostMessageMock).not.toHaveBeenCalled();
  });

  it("skips a command whose atomic claim was lost to a concurrent sweep", async () => {
    queueDbResults(
      [staleCommand()],
      [], // claim update matched no row — webhook or another sweep won
    );

    const result = await sweepStaleDetachedCommands(slackClient, NOW);

    expect(result).toEqual({
      detected: 1,
      failed: 0,
      jobExecutionsFailed: 0,
      recoveryPosted: 0,
    });
    expect(logErrorMock).not.toHaveBeenCalled();
    expect(safePostMessageMock).not.toHaveBeenCalled();
  });

  it("does not touch a job execution that already completed", async () => {
    queueDbResults(
      [staleCommand()],
      [{ id: "abcdef12" }],
      [], // conditional update (status = 'running' guard) matched no row
    );

    const result = await sweepStaleDetachedCommands(slackClient, NOW);

    expect(result.failed).toBe(1);
    expect(result.jobExecutionsFailed).toBe(0);
  });

  it("skips the job execution update entirely when no jobExecutionId is linked", async () => {
    queueDbResults(
      [staleCommand({ jobId: null, jobExecutionId: null })],
      [{ id: "abcdef12" }],
    );

    const result = await sweepStaleDetachedCommands(slackClient, NOW);

    expect(result.failed).toBe(1);
    expect(result.jobExecutionsFailed).toBe(0);
    // Only the claim update ran — no second update for job_executions.
    expect(updateSets()).toHaveLength(1);
  });

  it("posts one recovery message when the command has an origin thread", async () => {
    queueDbResults(
      [staleCommand({ channelId: "C123", threadTs: "1710000000.000000", jobExecutionId: null })],
      [{ id: "abcdef12" }],
    );

    const result = await sweepStaleDetachedCommands(slackClient, NOW);

    expect(result.recoveryPosted).toBe(1);
    expect(safePostMessageMock).toHaveBeenCalledTimes(1);
    expect(safePostMessageMock).toHaveBeenCalledWith(slackClient, {
      channel: "C123",
      text: DETACHED_COMMAND_RECOVERY_MESSAGE,
      thread_ts: "1710000000.000000",
    });
  });

  it("does not post when channel or thread is missing", async () => {
    queueDbResults(
      [staleCommand({ channelId: "C123", threadTs: null, jobExecutionId: null })],
      [{ id: "abcdef12" }],
    );

    await sweepStaleDetachedCommands(slackClient, NOW);

    expect(safePostMessageMock).not.toHaveBeenCalled();
  });

  it("keeps the command failed (no retry) when the recovery post fails", async () => {
    queueDbResults(
      [staleCommand({ channelId: "C123", threadTs: "1710000000.000000", jobExecutionId: null })],
      [{ id: "abcdef12" }],
    );
    safePostMessageMock.mockRejectedValueOnce(new Error("slack down"));

    const result = await sweepStaleDetachedCommands(slackClient, NOW);

    expect(result.failed).toBe(1);
    expect(result.recoveryPosted).toBe(0);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "detached_watchdog_recovery_post_error",
      expect.objectContaining({ id: "abcdef12", error: "slack down" }),
    );
  });

  it("still fails the command when the job execution update throws", async () => {
    queueDbResults([staleCommand()], [{ id: "abcdef12" }]);
    // Third operation (job execution update) throws.
    dbMock.update
      .mockImplementationOnce(dbMock.update.getMockImplementation()!)
      .mockImplementationOnce(() => {
        throw new Error("db unreachable");
      });

    const result = await sweepStaleDetachedCommands(slackClient, NOW);

    expect(result.failed).toBe(1);
    expect(result.jobExecutionsFailed).toBe(0);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "detached_watchdog_job_execution_update_failed",
      expect.objectContaining({ id: "abcdef12", error: "db unreachable" }),
    );
  });

  it("produces zero output when nothing is stale", async () => {
    queueDbResults([]);

    const result = await sweepStaleDetachedCommands(slackClient, NOW);

    expect(result).toEqual({
      detected: 0,
      failed: 0,
      jobExecutionsFailed: 0,
      recoveryPosted: 0,
    });
    expect(updateSets()).toEqual([]);
    expect(logErrorMock).not.toHaveBeenCalled();
    expect(safePostMessageMock).not.toHaveBeenCalled();
  });

  it("never throws even when the DB query fails", async () => {
    dbMock.select.mockImplementationOnce(() => {
      throw new Error("db unreachable");
    });

    await expect(sweepStaleDetachedCommands(slackClient, NOW)).resolves.toEqual({
      detected: 0,
      failed: 0,
      jobExecutionsFailed: 0,
      recoveryPosted: 0,
    });
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      "detached_watchdog_sweep_failed",
      expect.objectContaining({ error: "db unreachable" }),
    );
  });

  describe("detachedCommandWatchdogStaleMs", () => {
    it("defaults to 20 minutes", () => {
      expect(detachedCommandWatchdogStaleMs()).toBe(20 * 60 * 1000);
    });

    it("honors DETACHED_WATCHDOG_STALE_MINUTES", () => {
      process.env.DETACHED_WATCHDOG_STALE_MINUTES = "45";
      expect(detachedCommandWatchdogStaleMs()).toBe(45 * 60 * 1000);
    });

    it("falls back to the default for invalid values", () => {
      process.env.DETACHED_WATCHDOG_STALE_MINUTES = "not-a-number";
      expect(detachedCommandWatchdogStaleMs()).toBe(20 * 60 * 1000);
      process.env.DETACHED_WATCHDOG_STALE_MINUTES = "-5";
      expect(detachedCommandWatchdogStaleMs()).toBe(20 * 60 * 1000);
    });
  });
});
