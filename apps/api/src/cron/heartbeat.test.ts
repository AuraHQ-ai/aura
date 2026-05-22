import { readFileSync } from "node:fs";
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
const safePostMessageMock = vi.hoisted(() => vi.fn());

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

vi.mock("../lib/slack-messaging.js", () => ({
  safePostMessage: safePostMessageMock,
}));

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
    safePostMessageMock.mockResolvedValue({ ok: true });
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

  it("auto-recovers stale exhausted recurring jobs without legacy DM escalation", async () => {
    const recurringJob = baseJob({
      cronSchedule: "0 10 * * *",
      name: "sync-meta-comments-daily",
      lastResult: "upstream API failed",
    });

    queueDbResults(
      [], // pending jobs
      [], // expired plan notes
      [], // stale plan notes
      [], // orphan pending_review outcomes
      [], // orphan in_progress outcomes
      [], // dequeued jobs without execution rows
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
    expect(sendJobFailureDmMock).not.toHaveBeenCalled();
  });

  it("fails stale exhausted one-shot jobs without legacy DM escalation", async () => {
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
    expect(sendJobFailureDmMock).not.toHaveBeenCalled();
  });

  it("keeps healthy stale recovery for jobs below the retry limit", async () => {
    queueDbResults(
      [],
      [],
      [],
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

  it("sweep refires webhook for outcomes stuck in pending_review past 5min", async () => {
    process.env.AURA_PUBLIC_URL = "https://aura.test";
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    queueDbResults(
      [{ id: "00000000-0000-4000-8000-000000000101" }],
      [],
      [],
    );

    const { sweepOrphanedOutcomes } = await import("./heartbeat.js");
    const result = await sweepOrphanedOutcomes();

    expect(result.pendingReviewRefired).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://aura.test/api/cron/supervisor",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ outcomeId: "00000000-0000-4000-8000-000000000101" }),
        keepalive: true,
      }),
    );
    expect(updateSets()).toEqual([]);
  });

  it("sweep resets in_progress outcomes past 10min back to pending_review when attempts < 3", async () => {
    process.env.AURA_PUBLIC_URL = "https://aura.test";
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    queueDbResults(
      [],
      [{ id: "00000000-0000-4000-8000-000000000102", jobId: "job-1", supervisorAttempts: 2 }],
      [{ id: "00000000-0000-4000-8000-000000000102" }],
      [],
    );

    const { sweepOrphanedOutcomes } = await import("./heartbeat.js");
    const result = await sweepOrphanedOutcomes();

    expect(result.inProgressReset).toBe(1);
    expect(updateSets()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          supervisorStatus: "pending_review",
          supervisorInvocationId: null,
          supervisorStartedAt: null,
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://aura.test/api/cron/supervisor",
      expect.objectContaining({
        body: JSON.stringify({ outcomeId: "00000000-0000-4000-8000-000000000102" }),
      }),
    );
  });

  it("sweep marks in_progress outcomes as skipped + DMs when attempts >= 3", async () => {
    queueDbResults(
      [],
      [{ id: "00000000-0000-4000-8000-000000000103", jobId: "job-1", supervisorAttempts: 3 }],
      [{ id: "00000000-0000-4000-8000-000000000103", jobId: "job-1" }],
      [{ id: "job-1", name: "stuck supervisor job", requestedBy: "U_REQUESTER" }],
      [],
    );

    const { sweepOrphanedOutcomes } = await import("./heartbeat.js");
    const result = await sweepOrphanedOutcomes();

    expect(result.inProgressSkipped).toBe(1);
    expect(updateSets()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          supervisorStatus: "skipped",
          supervisorReasoning: "max supervisor attempts exceeded",
        }),
      ]),
    );
    expect(safePostMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: "U_REQUESTER",
        text: "Supervisor for job stuck supervisor job exhausted retries; manual intervention needed",
      }),
    );
  });

  it("sweep writes process_died_pre_execution outcome for jobs dequeued without execution row", async () => {
    process.env.AURA_PUBLIC_URL = "https://aura.test";
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    queueDbResults(
      [],
      [],
      [
        {
          id: "job-lost",
          workspaceId: "default",
          name: "lost before execution",
          executeAt: new Date("2026-05-20T08:45:00.000Z"),
          updatedAt: new Date("2026-05-20T08:46:00.000Z"),
        },
      ],
      [{ id: "00000000-0000-4000-8000-000000000104" }],
      [],
    );

    const { sweepOrphanedOutcomes } = await import("./heartbeat.js");
    const result = await sweepOrphanedOutcomes();

    expect(result.dequeuedWithoutExecution).toBe(1);
    expect(insertValues()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "default",
          jobId: "job-lost",
          jobExecutionId: null,
          outcomeStatus: "process_died_pre_execution",
          output: expect.objectContaining({
            type: "process_died_pre_execution",
            recovered_by: "heartbeat",
            execute_at: "2026-05-20T08:45:00.000Z",
            dequeued_at: "2026-05-20T08:46:00.000Z",
          }),
          error: "Job was dequeued but no execution row was created",
          lastNSteps: [],
          supervisorStatus: "pending_review",
        }),
      ]),
    );
    expect(updateSets()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          result: "Failed: worker died before creating a job execution row",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://aura.test/api/cron/supervisor",
      expect.objectContaining({
        body: JSON.stringify({ outcomeId: "00000000-0000-4000-8000-000000000104" }),
      }),
    );
  });

  it("legacy escalation is no longer called", () => {
    const source = readFileSync(new URL("./heartbeat.ts", import.meta.url), "utf8");
    const legacyFunction = ["maybe", "Escalate", "Consecutive", "Recurring", "Failures"].join("");
    const legacyMarkerTopic = ["job", "failure", "streak"].join("_");

    expect(source).not.toContain(legacyFunction);
    expect(source).not.toContain(legacyMarkerTopic);
  });

});
