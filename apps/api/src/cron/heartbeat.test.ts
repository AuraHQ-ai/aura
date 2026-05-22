import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      set: vi.fn((setArg: Record<string, unknown>) => {
        operation.setArg = setArg;
        return query;
      }),
      values: vi.fn((valuesArg: Record<string, unknown>) => {
        operation.valuesArg = valuesArg;
        return query;
      }),
      onConflictDoUpdate: vi.fn(() => query),
      onConflictDoNothing: vi.fn(() => query),
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

const executeJobMock = vi.hoisted(() => vi.fn());
const sendJobFailureDmMock = vi.hoisted(() => vi.fn());

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

vi.mock("./execute-job.js", () => ({
  MAX_RETRIES: 3,
  executeJob: executeJobMock,
}));

vi.mock("./job-notifications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./job-notifications.js")>();
  return {
    ...actual,
    sendJobFailureDm: sendJobFailureDmMock,
  };
});

function queueDbResults(...results: unknown[][]) {
  dbMock.results = [...results];
}

function updateSets() {
  return dbMock.operations
    .filter((operation) => operation.kind === "update")
    .map((operation) => operation.setArg ?? {});
}

function insertValues() {
  return dbMock.operations
    .filter((operation) => operation.kind === "insert")
    .map((operation) => operation.valuesArg ?? {});
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
  const originalFounderUserId = process.env.FOUNDER_USER_ID;
  const originalAuraAdminUserIds = process.env.AURA_ADMIN_USER_IDS;
  const originalAuraPublicUrl = process.env.AURA_PUBLIC_URL;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:59:00.000Z"));
    dbMock.results = [];
    dbMock.operations = [];
    vi.clearAllMocks();
    sendJobFailureDmMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
    if (originalFounderUserId === undefined) {
      delete process.env.FOUNDER_USER_ID;
    } else {
      process.env.FOUNDER_USER_ID = originalFounderUserId;
    }
    if (originalAuraAdminUserIds === undefined) {
      delete process.env.AURA_ADMIN_USER_IDS;
    } else {
      process.env.AURA_ADMIN_USER_IDS = originalAuraAdminUserIds;
    }
    if (originalAuraPublicUrl === undefined) {
      delete process.env.AURA_PUBLIC_URL;
    } else {
      process.env.AURA_PUBLIC_URL = originalAuraPublicUrl;
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

  it("writes a pending-review interrupted outcome for stale running recovery", async () => {
    queueDbResults(
      [],
      [],
      [],
      [{ id: "job-stale", name: "healthy-retry", workspaceId: "default" }],
      [],
      [{ id: "exec-stale", jobId: "job-stale" }],
    );

    const { heartbeatApp } = await import("./heartbeat.js");
    const response = await heartbeatApp.request("/api/cron/heartbeat", {
      headers: { authorization: "Bearer test-secret" },
    });

    expect(response.status).toBe(200);
    expect(insertValues()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "default",
          jobId: "job-stale",
          jobExecutionId: "exec-stale",
          outcomeStatus: "interrupted",
          output: expect.objectContaining({
            type: "stale_recovery",
            recovered_by: "heartbeat",
          }),
          error: "Execution interrupted: recovered by stale detection",
          lastNSteps: [],
          supervisorStatus: "pending_review",
        }),
      ]),
    );
  });

  it("invokes the supervisor webhook after persisting a stale recovery outcome", async () => {
    process.env.AURA_PUBLIC_URL = "https://aura.test";
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    queueDbResults(
      [],
      [],
      [],
      [{ id: "job-stale", name: "healthy-retry", workspaceId: "default" }],
      [],
      [{ id: "exec-stale", jobId: "job-stale" }],
      [{ id: "00000000-0000-4000-8000-000000000001" }],
    );

    const { heartbeatApp } = await import("./heartbeat.js");
    const response = await heartbeatApp.request("/api/cron/heartbeat", {
      headers: { authorization: "Bearer test-secret" },
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://aura.test/api/cron/supervisor",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-secret",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ outcomeId: "00000000-0000-4000-8000-000000000001" }),
        keepalive: true,
      }),
    );
  });

  it("does not fail heartbeat when the supervisor webhook rejects", async () => {
    process.env.AURA_PUBLIC_URL = "https://aura.test";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    queueDbResults(
      [],
      [],
      [],
      [{ id: "job-stale", name: "healthy-retry", workspaceId: "default" }],
      [],
      [{ id: "exec-stale", jobId: "job-stale" }],
      [{ id: "00000000-0000-4000-8000-000000000001" }],
    );

    const { heartbeatApp } = await import("./heartbeat.js");
    const response = await heartbeatApp.request("/api/cron/heartbeat", {
      headers: { authorization: "Bearer test-secret" },
    });

    expect(response.status).toBe(200);
  });

  it("does not fall back to founder or admin env vars for system-owned jobs", async () => {
    process.env.FOUNDER_USER_ID = "U_FOUNDER";
    process.env.AURA_ADMIN_USER_IDS = "U_ADMIN";

    const { resolveJobFailureDmTarget } = await import("./job-notifications.js");

    expect(resolveJobFailureDmTarget("aura")).toBeNull();
    expect(resolveJobFailureDmTarget(null)).toBeNull();
    expect(resolveJobFailureDmTarget(" U_OWNER ")).toBe("U_OWNER");
  });

  it("escalates after 5 consecutive failed recurring job executions", async () => {
    const recurringJob = baseJob({
      status: "pending",
      cronSchedule: "* * * * *",
      name: "sync-meta-comments-daily",
      lastResult: "previous failure",
    });
    const recentFailures = [0, 1, 2, 3, 4].map((index) => ({
      id: `exec-${index}`,
      status: "failed",
      startedAt: new Date(`2026-05-20T08:5${4 - index}:00.000Z`),
      error: index === 0 ? "Meta API timeout" : "previous error",
    }));

    executeJobMock.mockRejectedValueOnce(new Error("Meta API timeout"));
    queueDbResults(
      [recurringJob], // pending jobs
      [], // expired plan notes
      [], // stale plan notes
      [], // stale running jobs below max retries
      [], // stale exhausted jobs
      [], // stuck failed recurring jobs (none)
      recentFailures, // recent job executions
      [], // no existing marker
      [], // marker insert
    );

    const { heartbeatApp } = await import("./heartbeat.js");
    const response = await heartbeatApp.request("/api/cron/heartbeat", {
      headers: { authorization: "Bearer test-secret" },
    });

    expect(response.status).toBe(200);
    expect(sendJobFailureDmMock).toHaveBeenCalledOnce();
    expect(sendJobFailureDmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        requestedBy: "U_REQUESTER",
        text: expect.stringContaining(
          "Your recurring job `sync-meta-comments-daily` has failed 5 consecutive runs.",
        ),
      }),
    );
    expect(sendJobFailureDmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("It's been broken since 2026-05-20T08:50:00.000Z."),
      }),
    );
    expect(insertValues()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: "job-failure-streak:job-1",
          category: "job_failure_streak_marker",
          injectInContext: false,
        }),
      ]),
    );
  });

  it("does not duplicate escalation on the 6th consecutive failure in the same streak", async () => {
    const recurringJob = baseJob({
      status: "pending",
      cronSchedule: "* * * * *",
      name: "sync-meta-comments-daily",
    });
    const recentFailures = [0, 1, 2, 3, 4].map((index) => ({
      id: `exec-${index + 2}`,
      status: "failed",
      startedAt: new Date(`2026-05-20T08:5${5 - index}:00.000Z`),
      error: "still failing",
    }));

    executeJobMock.mockRejectedValueOnce(new Error("still failing"));
    queueDbResults(
      [recurringJob],
      [],
      [],
      [],
      [],
      [], // stuck failed recurring jobs (none)
      recentFailures,
      [{ id: "marker-1", updatedAt: new Date("2026-05-20T08:54:30.000Z") }],
      [], // no successful executions since the marker
    );

    const { heartbeatApp } = await import("./heartbeat.js");
    const response = await heartbeatApp.request("/api/cron/heartbeat", {
      headers: { authorization: "Bearer test-secret" },
    });

    expect(response.status).toBe(200);
    expect(sendJobFailureDmMock).not.toHaveBeenCalled();
    expect(insertValues()).toEqual([]);
  });

  it("does not escalate immediately after a successful run resets the streak", async () => {
    const recurringJob = baseJob({
      status: "pending",
      cronSchedule: "* * * * *",
      name: "sync-meta-comments-daily",
    });
    const recentExecutions = [
      {
        id: "exec-latest",
        status: "failed",
        startedAt: new Date("2026-05-20T08:58:00.000Z"),
        error: "new failure",
      },
      {
        id: "exec-success",
        status: "completed",
        startedAt: new Date("2026-05-20T08:57:00.000Z"),
        error: null,
      },
      {
        id: "exec-old-1",
        status: "failed",
        startedAt: new Date("2026-05-20T08:56:00.000Z"),
        error: "old failure",
      },
      {
        id: "exec-old-2",
        status: "failed",
        startedAt: new Date("2026-05-20T08:55:00.000Z"),
        error: "old failure",
      },
      {
        id: "exec-old-3",
        status: "failed",
        startedAt: new Date("2026-05-20T08:54:00.000Z"),
        error: "old failure",
      },
    ];

    executeJobMock.mockRejectedValueOnce(new Error("new failure"));
    queueDbResults(
      [recurringJob],
      [],
      [],
      [],
      [],
      [], // stuck failed recurring jobs (none)
      recentExecutions,
      [], // marker reset delete
    );

    const { heartbeatApp } = await import("./heartbeat.js");
    const response = await heartbeatApp.request("/api/cron/heartbeat", {
      headers: { authorization: "Bearer test-secret" },
    });

    expect(response.status).toBe(200);
    expect(sendJobFailureDmMock).not.toHaveBeenCalled();
    expect(insertValues()).toEqual([]);
  });

  it("escalates a recurring job already parked in status=failed (stuck since prior sweep)", async () => {
    const stuckJob = baseJob({
      status: "failed",
      cronSchedule: "0 * * * *",
      name: "sync-meta-comments-daily",
      lastResult: "Execution interrupted: recovered by stale detection",
    });
    const recentFailures = [0, 1, 2, 3, 4].map((index) => ({
      id: `exec-${index}`,
      status: "failed",
      startedAt: new Date(`2026-05-09T0${4 - index}:00:00.000Z`),
      error: "Execution interrupted: recovered by stale detection",
    }));

    queueDbResults(
      [], // pending jobs (none — stuck job is in status=failed)
      [], // expired plan notes
      [], // stale plan notes
      [], // stale running jobs below max retries
      [], // stale exhausted jobs
      [stuckJob], // stuck failed recurring jobs ← new query
      recentFailures, // recent job executions
      [], // no existing marker
      [], // marker insert
    );

    const { heartbeatApp } = await import("./heartbeat.js");
    const response = await heartbeatApp.request("/api/cron/heartbeat", {
      headers: { authorization: "Bearer test-secret" },
    });

    expect(response.status).toBe(200);
    expect(sendJobFailureDmMock).toHaveBeenCalledOnce();
    expect(sendJobFailureDmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        requestedBy: "U_REQUESTER",
        text: expect.stringContaining(
          "Your recurring job `sync-meta-comments-daily` has failed 5 consecutive runs.",
        ),
      }),
    );
    expect(insertValues()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: "job-failure-streak:job-1",
          category: "job_failure_streak_marker",
        }),
      ]),
    );
  });

});
