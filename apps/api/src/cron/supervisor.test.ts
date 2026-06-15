import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  type Operation = {
    kind: "select" | "update" | "insert";
    setArg?: Record<string, unknown>;
    valuesArg?: Record<string, unknown>;
  };

  const state = {
    results: [] as unknown[][],
    operations: [] as Operation[],
    select: vi.fn(),
    update: vi.fn(),
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
  state.insert.mockImplementation(() => createQuery({ kind: "insert" }));

  return state;
});

const generateObjectMock = vi.hoisted(() => vi.fn());
const getCredentialMock = vi.hoisted(() => vi.fn());
const sendJobFailureDmMock = vi.hoisted(() => vi.fn());

vi.mock("../db/client.js", () => ({
  db: {
    select: dbMock.select,
    update: dbMock.update,
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

vi.mock("../lib/ai.js", () => ({
  getFastModel: vi.fn(async () => "fast-model"),
}));

vi.mock("ai", () => ({
  generateObject: generateObjectMock,
}));

vi.mock("../lib/credentials.js", () => ({
  getCredential: getCredentialMock,
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

function jobMutationSets() {
  return updateSets().filter((set) => !("supervisorStatus" in set));
}

function finalOutcomeUpdate() {
  return updateSets().find((set) => set.supervisorStatus === "resolved");
}

function baseOutcome(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "default",
    jobId: "00000000-0000-4000-8000-000000000010",
    jobExecutionId: "00000000-0000-4000-8000-000000000020",
    outcomeStatus: "errored",
    output: { retry_exhausted: true },
    error: "model stream dropped",
    lastNSteps: [{ index: 0, text: "last step" }],
    supervisorStatus: "in_progress",
    supervisorInvocationId: "iad1::invocation",
    supervisorStartedAt: new Date("2026-05-20T09:00:00.000Z"),
    supervisorDecision: null,
    supervisorReasoning: null,
    supervisorAttempts: 1,
    createdAt: new Date("2026-05-20T08:59:00.000Z"),
    updatedAt: new Date("2026-05-20T09:00:00.000Z"),
    ...overrides,
  };
}

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    workspaceId: "default",
    name: "daily sync",
    description: "sync the external system",
    playbook: null,
    script: null,
    cronSchedule: null,
    notifyOnSuccess: false,
    frequencyConfig: null,
    channelId: null,
    threadTs: null,
    executeAt: null,
    requestedBy: "U_REQUESTER",
    priority: "normal",
    status: "failed",
    timezone: "UTC",
    result: null,
    retries: 3,
    lastExecutedAt: null,
    lastResult: "model stream dropped",
    executionCount: 1,
    todayExecutions: 1,
    lastExecutionDate: "2026-05-20",
    enabled: 1,
    requiredCredentialIds: [],
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-20T08:59:00.000Z"),
    ...overrides,
  };
}

function baseExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000020",
    workspaceId: "default",
    jobId: "00000000-0000-4000-8000-000000000010",
    startedAt: new Date("2026-05-20T08:55:00.000Z"),
    finishedAt: new Date("2026-05-20T08:58:00.000Z"),
    status: "failed",
    trigger: "heartbeat",
    callbackChannel: null,
    callbackThreadTs: null,
    steps: null,
    summary: null,
    tokenUsage: null,
    error: "model stream dropped",
    ...overrides,
  };
}

function promptContextFromGenerateCall() {
  const prompt = String(generateObjectMock.mock.calls.at(-1)?.[0]?.prompt ?? "");
  const contextJson = prompt.match(/Context:\n([\s\S]*)$/)?.[1];
  if (!contextJson) throw new Error("Supervisor prompt did not include JSON context");
  return JSON.parse(contextJson) as {
    job: { cron_schedule: string | null; notify_on_success: boolean };
    last_5_executions: Array<{ status: string; error: string | null }>;
  };
}

function mockCleanSuccessDecisionPolicy() {
  generateObjectMock.mockImplementation(async (args: { prompt: string }) => {
    const contextJson = args.prompt.match(/Context:\n([\s\S]*)$/)?.[1];
    if (!contextJson) throw new Error("Supervisor prompt did not include JSON context");
    const context = JSON.parse(contextJson) as {
      job: { cron_schedule: string | null; notify_on_success: boolean };
      last_5_executions: Array<{ status: string; error: string | null }>;
    };
    const recoveredFromFailure = context.last_5_executions.some(
      (execution) => execution.status === "failed" || execution.error,
    );
    const shouldReport =
      context.job.notify_on_success || context.job.cron_schedule === null || recoveredFromFailure;

    return {
      object: {
        decision: shouldReport ? "report_success" : "silent_success",
        reasoning: shouldReport ? "Success should be reported." : "Routine recurring success.",
      },
    };
  });
}

async function invokeSupervisor() {
  const { supervisorApp } = await import("./supervisor.js");
  return supervisorApp.request("/api/cron/supervisor", {
    method: "POST",
    headers: {
      authorization: "Bearer test-secret",
      "content-type": "application/json",
      "x-vercel-id": "iad1::invocation",
    },
    body: JSON.stringify({ outcomeId: "00000000-0000-4000-8000-000000000001" }),
  });
}

describe("supervisor cron", () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const originalFounderUserId = process.env.FOUNDER_USER_ID;
  const originalAuraPublicUrl = process.env.AURA_PUBLIC_URL;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret";
    process.env.AURA_PUBLIC_URL = "https://aura.test";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T09:00:00.000Z"));
    dbMock.results = [];
    dbMock.operations = [];
    vi.clearAllMocks();
    generateObjectMock.mockResolvedValue({
      object: {
        decision: "report_failure",
        reasoning: "The job failed permanently.",
        user_message: "I could not complete the job.",
      },
    });
    getCredentialMock.mockResolvedValue("gh-token");
    sendJobFailureDmMock.mockResolvedValue(true);
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url.startsWith("https://api.github.com/repos/AuraHQ-ai/aura/issues?")) {
        return {
          ok: true,
          json: async () => [],
          text: async () => "",
        };
      }

      if (method === "POST" && url === "https://api.github.com/repos/AuraHQ-ai/aura/issues") {
        return {
          ok: true,
          json: async () => ({ html_url: "https://github.com/AuraHQ-ai/aura/issues/123" }),
          text: async () => "",
        };
      }

      if (
        method === "POST" &&
        url === "https://api.github.com/repos/AuraHQ-ai/aura/issues/456/comments"
      ) {
        return {
          ok: true,
          json: async () => ({ html_url: "https://github.com/AuraHQ-ai/aura/issues/456#issuecomment-1" }),
          text: async () => "",
        };
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => `Unhandled fetch ${method} ${url}`,
      };
    });
    vi.stubGlobal("fetch", fetchMock);
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
    if (originalAuraPublicUrl === undefined) {
      delete process.env.AURA_PUBLIC_URL;
    } else {
      process.env.AURA_PUBLIC_URL = originalAuraPublicUrl;
    }
  });

  it("acquires the idempotency lock and finalizes the outcome", async () => {
    queueDbResults([baseOutcome()], [baseJob()], [baseExecution()]);

    const response = await invokeSupervisor();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, decision: "report_failure" });
    expect(updateSets()[0]).toMatchObject({
      supervisorStatus: "in_progress",
      supervisorInvocationId: "iad1::invocation",
    });
    expect(updateSets()[0].supervisorAttempts).toBeDefined();
    expect(finalOutcomeUpdate()).toMatchObject({
      supervisorStatus: "resolved",
      supervisorDecision: "report_failure",
      supervisorReasoning: "The job failed permanently.",
    });
  });

  it("skips when another invocation already claimed the outcome", async () => {
    queueDbResults([]);

    const response = await invokeSupervisor();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, skipped: true, reason: "already_claimed" });
    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(updateSets()).toHaveLength(1);
  });

  it.each([
    ["silent_success", { outcomeStatus: "succeeded", error: null }, { dmCount: 0 }],
    ["report_success", { outcomeStatus: "succeeded", error: null }, { dmCount: 1 }],
    ["report_failure", {}, { dmCount: 1 }],
    ["retry_as_is", {}, { dmCount: 1, jobUpdate: { status: "pending", retries: 0 } }],
    ["retry_with_fix", {}, { dmCount: 1, jobUpdate: { status: "pending", retries: 0 }, issue: true }],
    ["escalate", {}, { dmCount: 2, founder: true }],
    ["disable_job", {}, { dmCount: 1, jobUpdate: { enabled: 0 } }],
  ])(
    "applies %s with the right side effects",
    async (decisionName, outcomeOverrides, expected) => {
      if ("founder" in expected && expected.founder) {
        process.env.FOUNDER_USER_ID = "U_FOUNDER";
      }
      generateObjectMock.mockResolvedValue({
        object: {
          decision: decisionName,
          reasoning: `reason for ${decisionName}`,
          user_message: `message for ${decisionName}`,
        },
      });
      queueDbResults([baseOutcome(outcomeOverrides)], [baseJob()], [baseExecution()]);

      const response = await invokeSupervisor();

      expect(response.status).toBe(200);
      expect(sendJobFailureDmMock).toHaveBeenCalledTimes(expected.dmCount);
      if ("founder" in expected && expected.founder) {
        expect(sendJobFailureDmMock).toHaveBeenCalledWith(
          expect.objectContaining({ requestedBy: "U_FOUNDER" }),
        );
      }
      if ("jobUpdate" in expected && expected.jobUpdate) {
        expect(jobMutationSets()).toEqual(
          expect.arrayContaining([expect.objectContaining(expected.jobUpdate)]),
        );
      } else {
        expect(jobMutationSets()).toEqual([]);
      }
      if ("issue" in expected && expected.issue) {
        expect(fetchMock).toHaveBeenCalledWith(
          "https://api.github.com/repos/AuraHQ-ai/aura/issues",
          expect.objectContaining({
            method: "POST",
            body: expect.stringContaining("last_n_steps"),
          }),
        );
        expect(sendJobFailureDmMock).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining("https://github.com/AuraHQ-ai/aura/issues/123"),
          }),
        );
      }
      expect(finalOutcomeUpdate()).toMatchObject({
        supervisorStatus: "resolved",
        supervisorDecision: decisionName,
      });
    },
  );

  it("comments on a matching open supervisor issue instead of creating a duplicate", async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        decision: "retry_with_fix",
        reasoning: "The configured model does not exist.",
        user_message: "I queued the job to retry after a fix.",
      },
    });
    const outcomeError =
      "Model claude-4.6-sonnet-20260613 failed at 2026-06-13T10:11:12.123Z for request 11111111-1111-4111-8111-111111111111 after 31 attempts";
    queueDbResults(
      [baseOutcome({ error: outcomeError })],
      [baseJob({ name: "evening sync" })],
      [baseExecution({ error: outcomeError })],
    );
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url.startsWith("https://api.github.com/repos/AuraHQ-ai/aura/issues?")) {
        return {
          ok: true,
          json: async () => [
            {
              number: 456,
              html_url: "https://github.com/AuraHQ-ai/aura/issues/456",
              title: "Supervisor fix needed: morning sync",
              body: [
                "## Deduplication",
                "- normalized_error_signature: `model claude-<number>-sonnet-<number> failed at <timestamp> for request <uuid> after <number> attempts`",
              ].join("\n"),
              created_at: "2026-05-20T08:30:00.000Z",
            },
          ],
          text: async () => "",
        };
      }

      if (
        method === "POST" &&
        url === "https://api.github.com/repos/AuraHQ-ai/aura/issues/456/comments"
      ) {
        return {
          ok: true,
          json: async () => ({ html_url: "https://github.com/AuraHQ-ai/aura/issues/456#issuecomment-1" }),
          text: async () => "",
        };
      }

      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => `Unexpected fetch ${method} ${url}`,
      };
    });

    const response = await invokeSupervisor();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/api\.github\.com\/repos\/AuraHQ-ai\/aura\/issues\?/),
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://api.github.com/repos/AuraHQ-ai/aura/issues",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/AuraHQ-ai/aura/issues/456/comments",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("00000000-0000-4000-8000-000000000001"),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/AuraHQ-ai/aura/issues/456/comments",
      expect.objectContaining({
        body: expect.stringContaining(outcomeError),
      }),
    );
    expect(sendJobFailureDmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("https://github.com/AuraHQ-ai/aura/issues/456"),
      }),
    );
  });

  it.each([
    {
      name: "recurring clean success silently resolves",
      job: baseJob({ cronSchedule: "50 8 * * 1-5", notifyOnSuccess: false }),
      executions: [baseExecution({ status: "succeeded", error: null, summary: "No changes needed" })],
      expectedDecision: "silent_success",
      expectedDmCount: 0,
    },
    {
      name: "one-shot clean success reports completion",
      job: baseJob({ cronSchedule: null, notifyOnSuccess: false }),
      executions: [baseExecution({ status: "succeeded", error: null, summary: "Task completed" })],
      expectedDecision: "report_success",
      expectedDmCount: 1,
    },
    {
      name: "recurring clean success with notify_on_success reports completion",
      job: baseJob({ cronSchedule: "0 9 * * *", notifyOnSuccess: true }),
      executions: [baseExecution({ status: "succeeded", error: null, summary: "Task completed" })],
      expectedDecision: "report_success",
      expectedDmCount: 1,
    },
    {
      name: "recovered clean success reports completion",
      job: baseJob({ cronSchedule: "0 9 * * *", notifyOnSuccess: false }),
      executions: [
        baseExecution({ status: "succeeded", error: null, summary: "Recovered" }),
        baseExecution({
          id: "00000000-0000-4000-8000-000000000021",
          status: "failed",
          error: "Previous run failed",
        }),
      ],
      expectedDecision: "report_success",
      expectedDmCount: 1,
    },
  ])("$name", async ({ job, executions, expectedDecision, expectedDmCount }) => {
    mockCleanSuccessDecisionPolicy();
    queueDbResults(
      [baseOutcome({ outcomeStatus: "succeeded", error: null })],
      [job],
      executions,
    );

    const response = await invokeSupervisor();
    const body = await response.json();
    const prompt = String(generateObjectMock.mock.calls[0][0].prompt);
    const promptContext = promptContextFromGenerateCall();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, decision: expectedDecision });
    expect(prompt).toContain("silent_success");
    expect(prompt).toContain("default for routine recurring runs");
    expect(prompt).toContain("notify_on_success is true");
    expect(promptContext.job).toMatchObject({
      cron_schedule: job.cronSchedule,
      notify_on_success: job.notifyOnSuccess,
    });
    expect(sendJobFailureDmMock).toHaveBeenCalledTimes(expectedDmCount);
    expect(finalOutcomeUpdate()).toMatchObject({
      supervisorStatus: "resolved",
      supervisorDecision: expectedDecision,
    });
  });

  it("returns errored outcomes to pending_review when the LLM fails", async () => {
    generateObjectMock.mockRejectedValue(new Error("gateway unavailable"));
    queueDbResults([baseOutcome()], [baseJob()], [baseExecution()]);

    const response = await invokeSupervisor();

    expect(response.status).toBe(500);
    expect(updateSets()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          supervisorStatus: "pending_review",
          supervisorReasoning: "Supervisor failed: gateway unavailable",
        }),
      ]),
    );
  });

  it("short-circuits outcomes that reached the max supervisor attempts", async () => {
    queueDbResults([baseOutcome({ supervisorAttempts: 3 })]);

    const response = await invokeSupervisor();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      skipped: true,
      reason: "max_supervisor_attempts_exceeded",
    });
    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(updateSets()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          supervisorStatus: "skipped",
          supervisorReasoning: "max supervisor attempts exceeded",
        }),
      ]),
    );
  });
});
