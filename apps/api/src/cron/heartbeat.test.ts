import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  type Operation = {
    kind: "select" | "update" | "delete";
    setArg?: Record<string, unknown>;
  };

  const state = {
    results: [] as unknown[][],
    operations: [] as Operation[],
    select: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
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
      set: vi.fn((setArg: Record<string, unknown>) => {
        operation.setArg = setArg;
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

  return state;
});

const executeJobMock = vi.hoisted(() => vi.fn());
const sendJobFailureDmMock = vi.hoisted(() => vi.fn());

vi.mock("../db/client.js", () => ({
  db: {
    select: dbMock.select,
    update: dbMock.update,
    delete: dbMock.delete,
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

vi.mock("./execute-job.js", () => ({
  MAX_RETRIES: 3,
  executeJob: executeJobMock,
}));

vi.mock("./job-notifications.js", () => ({
  sendJobFailureDm: sendJobFailureDmMock,
  truncateJobFailureText: (value: string | null | undefined, maxChars = 400) => {
    const text = value?.trim() || "unknown";
    return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
  },
}));

function queueDbResults(...results: unknown[][]) {
  dbMock.results = [...results];
}

function updateSets() {
  return dbMock.operations
    .filter((operation) => operation.kind === "update")
    .map((operation) => operation.setArg ?? {});
}

function baseJob(overrides: Record<string, unknown>) {
  return {
    id: "job-1",
    workspaceId: "default",
    name: "test-job",
    description: "do the thing",
    playbook: null,
    script: null,
    cronSchedule: null,
    frequencyConfig: null,
    channelId: null,
    threadTs: null,
    executeAt: null,
    requestedBy: "U_REQUESTER",
    priority: "normal",
    status: "running",
    timezone: "UTC",
    result: null,
    retries: 3,
    lastExecutedAt: null,
    lastResult: "last failure",
    executionCount: 0,
    todayExecutions: 0,
    lastExecutionDate: null,
    enabled: 1,
    requiredCredentialIds: [],
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-20T08:00:00.000Z"),
    ...overrides,
  };
}

describe("heartbeat stale running recovery", () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:59:00.000Z"));
    dbMock.results = [];
    dbMock.operations = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it("auto-recovers stale exhausted recurring jobs and sends a DM", async () => {
    const recurringJob = baseJob({
      cronSchedule: "0 10 * * *",
      name: "sync-meta-comments-daily",
      lastResult: "upstream API failed",
    });

    queueDbResults(
      [], // pending jobs
      [], // expired plan notes
      [], // stale plan notes
      [], // stale running jobs below max retries
      [recurringJob], // stale exhausted jobs
      [], // recurring recovery update
      [], // running execution cleanup
    );

    const { heartbeatApp } = await import("./heartbeat.js");
    const response = await heartbeatApp.request("/api/cron/heartbeat", {
      headers: { authorization: "Bearer test-secret" },
    });

    expect(response.status).toBe(200);
    const recoveredUpdate = updateSets().find(
      (set) => set.status === "pending" && set.retries === 0,
    );
    expect(recoveredUpdate).toMatchObject({
      status: "pending",
      retries: 0,
    });
    expect((recoveredUpdate?.executeAt as Date).toISOString()).toBe(
      "2026-05-20T10:00:00.000Z",
    );
    expect(sendJobFailureDmMock).toHaveBeenCalledOnce();
    expect(sendJobFailureDmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        requestedBy: "U_REQUESTER",
        text: expect.stringContaining("Auto-recovered. Next attempt: 2026-05-20T10:00:00.000Z."),
      }),
    );
  });

  it("fails stale exhausted one-shot jobs and sends a DM", async () => {
    const oneShotJob = baseJob({
      cronSchedule: null,
      name: "one-shot-followup",
      lastResult: "tool failed",
    });

    queueDbResults(
      [],
      [],
      [],
      [],
      [oneShotJob],
      [], // one-shot failure update
      [], // running execution cleanup
    );

    const { heartbeatApp } = await import("./heartbeat.js");
    const response = await heartbeatApp.request("/api/cron/heartbeat", {
      headers: { authorization: "Bearer test-secret" },
    });

    expect(response.status).toBe(200);
    const failedUpdate = updateSets().find((set) => set.status === "failed");
    expect(failedUpdate).toMatchObject({
      status: "failed",
      result: "Failed: job stuck in running state and exceeded retry limit",
    });
    expect(sendJobFailureDmMock).toHaveBeenCalledOnce();
    expect(sendJobFailureDmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        requestedBy: "U_REQUESTER",
        text: "Job one-shot-followup exhausted retries. Last error: tool failed.",
      }),
    );
  });

  it("keeps healthy stale recovery for jobs below the retry limit", async () => {
    queueDbResults(
      [],
      [],
      [],
      [{ id: "job-healthy", name: "healthy-retry" }],
      [], // no stale exhausted jobs
      [], // running execution cleanup
    );

    const { heartbeatApp } = await import("./heartbeat.js");
    const response = await heartbeatApp.request("/api/cron/heartbeat", {
      headers: { authorization: "Bearer test-secret" },
    });

    expect(response.status).toBe(200);
    expect(updateSets()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "pending",
        }),
      ]),
    );
    expect(
      updateSets().some(
        (set) => set.result === "Failed: job stuck in running state and exceeded retry limit",
      ),
    ).toBe(false);
    expect(sendJobFailureDmMock).not.toHaveBeenCalled();
  });
});
