import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectScriptOutputError } from "./script-output.js";

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

const sandboxMock = vi.hoisted(() => ({
  commandRun: vi.fn(),
  getOrCreateSandbox: vi.fn(),
  getSandboxEnvs: vi.fn(),
  filterEnvsByAllowlist: vi.fn(
    (envs: Record<string, string>, allowlist: string[] | null | undefined) => {
      if (allowlist == null) return envs;
      const allowed = new Set(allowlist.map((name) => name.toUpperCase()));
      return Object.fromEntries(
        Object.entries(envs).filter(([name]) => allowed.has(name.toUpperCase())),
      );
    },
  ),
}));

const createHeadlessAgentMock = vi.hoisted(() => vi.fn());
const resolveUserCredentialsMock = vi.hoisted(() =>
  vi.fn(async (_userId?: string) => new Set<string>()),
);
const sendJobOpsNoticeMock = vi.hoisted(() =>
  vi.fn(async (_notice: Record<string, unknown>) => ({
    ok: true,
    target: "ops_channel" as const,
  })),
);
const buildStablePrefixMock = vi.hoisted(() =>
  vi.fn(async () => "full stable prefix"),
);
const buildTaskPrefixMock = vi.hoisted(() => vi.fn(() => "minimal task prefix"));

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

vi.mock("../lib/sandbox.js", () => ({
  getOrCreateSandbox: sandboxMock.getOrCreateSandbox,
  getSandboxEnvs: sandboxMock.getSandboxEnvs,
  filterEnvsByAllowlist: sandboxMock.filterEnvsByAllowlist,
  truncateOutput: (value: string, maxChars: number) => value.slice(0, maxChars),
}));

vi.mock("../personality/system-prompt.js", () => ({
  buildStablePrefix: buildStablePrefixMock,
  buildTaskPrefix: buildTaskPrefixMock,
}));

vi.mock("../lib/temporal.js", () => ({
  getCurrentTimeContext: vi.fn(() => "current time"),
}));

vi.mock("../lib/agents.js", () => ({
  createHeadlessAgent: createHeadlessAgentMock,
}));

vi.mock("../lib/permissions.js", () => ({
  resolveUserCredentials: resolveUserCredentialsMock,
}));

vi.mock("./job-notifications.js", () => ({
  sendJobOpsNotice: sendJobOpsNoticeMock,
}));

vi.mock("./persist-conversation.js", () => ({
  createConversationTrace: vi.fn(),
  persistConversationInputs: vi.fn(),
  persistConversationSteps: vi.fn(),
  persistConversationError: vi.fn(),
  updateConversationTraceUsage: vi.fn(),
  buildConversationSteps: vi.fn(),
}));

vi.mock("../tools/scratchpad.js", () => ({
  getScratchpadContents: vi.fn(() => null),
  cleanupScratchpad: vi.fn(),
}));

function queueDbResults(...results: unknown[][]) {
  dbMock.results = [...results];
}

function insertValues() {
  return dbMock.operations
    .filter((operation) => operation.kind === "insert")
    .map((operation) => operation.valuesArg ?? {});
}

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    workspaceId: "default",
    name: "test-job",
    description: "do the thing",
    playbook: null,
    script: "node script.js",
    cronSchedule: null,
    frequencyConfig: null,
    channelId: null,
    threadTs: null,
    executeAt: new Date("2026-05-20T09:00:00.000Z"),
    requestedBy: "U_REQUESTER",
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
    requiredCredentialIds: [],
    model: null,
    envAllowlist: null,
    promptMode: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-20T08:00:00.000Z"),
    ...overrides,
  };
}

describe("executeJob outcome persistence", () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const originalAuraPublicUrl = process.env.AURA_PUBLIC_URL;

  beforeEach(() => {
    dbMock.results = [];
    dbMock.operations = [];
    vi.clearAllMocks();
    sandboxMock.getSandboxEnvs.mockResolvedValue({});
    sandboxMock.getOrCreateSandbox.mockResolvedValue({
      commands: {
        run: sandboxMock.commandRun,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
    if (originalAuraPublicUrl === undefined) {
      delete process.env.AURA_PUBLIC_URL;
    } else {
      process.env.AURA_PUBLIC_URL = originalAuraPublicUrl;
    }
  });

  it("writes a pending-review succeeded outcome for script-only success", async () => {
    sandboxMock.commandRun.mockResolvedValue({
      exitCode: 0,
      stdout: "{\"ok\":true,\"summary\":\"done\"}",
      stderr: "",
    });
    queueDbResults(
      [{ id: "job-1" }],
      [{ id: "exec-1" }],
    );

    const { executeJob } = await import("./execute-job.js");
    await expect(executeJob(baseJob() as any, "heartbeat")).resolves.toBe(true);

    expect(insertValues()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "default",
          jobId: "job-1",
          jobExecutionId: "exec-1",
          outcomeStatus: "succeeded",
          output: expect.objectContaining({
            type: "script",
            script: expect.objectContaining({
              stdout: "{\"ok\":true,\"summary\":\"done\"}",
              stderr: "",
              exit_code: 0,
            }),
          }),
          lastNSteps: [],
          supervisorStatus: "pending_review",
          supervisorAttempts: 0,
        }),
      ]),
    );
  });

  it("writes a pending-review errored outcome when retries are exhausted", async () => {
    sandboxMock.commandRun.mockResolvedValue({
      exitCode: 2,
      stdout: "partial output",
      stderr: "boom",
    });
    queueDbResults(
      [{ id: "job-1" }],
      [{ id: "exec-1" }],
    );

    const { executeJob } = await import("./execute-job.js");
    await expect(
      executeJob(baseJob({ retries: 2 }) as any, "heartbeat"),
    ).rejects.toThrow("Script exited with code 2");

    expect(insertValues()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "default",
          jobId: "job-1",
          jobExecutionId: "exec-1",
          outcomeStatus: "errored",
          output: expect.objectContaining({
            script: expect.objectContaining({
              stdout: "partial output",
              stderr: "boom",
              exit_code: 2,
            }),
            retry_exhausted: true,
          }),
          error: expect.stringContaining("Script exited with code 2"),
          lastNSteps: [],
          supervisorStatus: "pending_review",
        }),
      ]),
    );
  });

  it("writes an errored outcome for caught non-script failures", async () => {
    createHeadlessAgentMock.mockRejectedValue(new Error("model unavailable"));
    queueDbResults(
      [{ id: "job-1" }],
      [{ id: "exec-1" }],
    );

    const { executeJob } = await import("./execute-job.js");
    await expect(
      executeJob(baseJob({ script: null }) as any, "heartbeat"),
    ).rejects.toThrow("model unavailable");

    expect(insertValues()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "default",
          jobId: "job-1",
          jobExecutionId: "exec-1",
          outcomeStatus: "errored",
          output: expect.objectContaining({
            retry_exhausted: false,
          }),
          error: "model unavailable",
          lastNSteps: [],
          supervisorStatus: "pending_review",
        }),
      ]),
    );
  });

  it("invokes the supervisor webhook after persisting an outcome", async () => {
    process.env.CRON_SECRET = "test-secret";
    process.env.AURA_PUBLIC_URL = "https://aura.test";
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    sandboxMock.commandRun.mockResolvedValue({
      exitCode: 0,
      stdout: "{\"ok\":true,\"summary\":\"done\"}",
      stderr: "",
    });
    queueDbResults(
      [{ id: "job-1" }],
      [{ id: "exec-1" }],
      [],
      [],
      [{ id: "00000000-0000-4000-8000-000000000001" }],
    );

    const { executeJob } = await import("./execute-job.js");
    await expect(executeJob(baseJob() as any, "heartbeat")).resolves.toBe(true);

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

  it("does not fail the worker when the supervisor webhook rejects", async () => {
    process.env.CRON_SECRET = "test-secret";
    process.env.AURA_PUBLIC_URL = "https://aura.test";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    sandboxMock.commandRun.mockResolvedValue({
      exitCode: 0,
      stdout: "{\"ok\":true,\"summary\":\"done\"}",
      stderr: "",
    });
    queueDbResults(
      [{ id: "job-1" }],
      [{ id: "exec-1" }],
      [],
      [],
      [{ id: "00000000-0000-4000-8000-000000000001" }],
    );

    const { executeJob } = await import("./execute-job.js");

    await expect(executeJob(baseJob() as any, "heartbeat")).resolves.toBe(true);
  });
});
describe("executeJob reply-routing prompt", () => {
  beforeEach(() => {
    dbMock.results = [];
    dbMock.operations = [];
    vi.clearAllMocks();
  });

  async function capturePromptForJob(jobOverrides: Record<string, unknown>): Promise<string> {
    let capturedPrompt = "";
    createHeadlessAgentMock.mockResolvedValue({
      agent: {
        generate: vi.fn(async ({ prompt }: { prompt: string }) => {
          capturedPrompt = prompt;
          throw new Error("stop-after-prompt-capture");
        }),
      },
      modelId: "test-model",
      getStepModelIds: () => [],
    });
    queueDbResults([{ id: "job-1" }], [{ id: "exec-1" }]);

    const { executeJob } = await import("./execute-job.js");
    await expect(
      executeJob(baseJob({ script: null, ...jobOverrides }) as any, "heartbeat"),
    ).rejects.toThrow("stop-after-prompt-capture");

    return capturedPrompt;
  }

  it("includes the silent-success clause in the thread-routing variant", async () => {
    const { SILENT_SUCCESS_CLAUSE } = await import("./execute-job.js");
    const prompt = await capturePromptForJob({ channelId: "C123", threadTs: "111.222" });

    expect(prompt).toContain('send_thread_reply(channel="C123", thread_ts="111.222")');
    expect(prompt).toContain(SILENT_SUCCESS_CLAUSE);
    expect(prompt).toContain("post NOTHING");
    expect(prompt).toContain("output exactly `NO_OP`");
  });

  it("includes the silent-success clause in the channel-routing variant", async () => {
    const { SILENT_SUCCESS_CLAUSE } = await import("./execute-job.js");
    const prompt = await capturePromptForJob({ channelId: "C123", threadTs: null });

    expect(prompt).toContain('Post your results to channel "C123" using send_channel_message');
    expect(prompt).toContain(SILENT_SUCCESS_CLAUSE);
    expect(prompt).toContain("post NOTHING");
    expect(prompt).toContain("output exactly `NO_OP`");
  });

  it("does not inject reply-routing for jobs without a channel", async () => {
    const prompt = await capturePromptForJob({ channelId: null, threadTs: null });

    expect(prompt).not.toContain("Post your results");
    expect(prompt).not.toContain("post NOTHING");
    expect(prompt).not.toContain("NO_OP");
  });
});

describe("executeJob NO_OP sentinel contract", () => {
  beforeEach(() => {
    dbMock.results = [];
    dbMock.operations = [];
    vi.clearAllMocks();
  });

  function mockAgentGenerate(text: string, steps: Array<Record<string, unknown>> = []) {
    createHeadlessAgentMock.mockResolvedValue({
      agent: {
        generate: vi.fn(async () => ({ text, steps, totalUsage: {} })),
      },
      modelId: "test-model",
      getStepModelIds: () => [],
    });
  }

  function updateSetArgs() {
    return dbMock.operations
      .filter((operation) => operation.kind === "update")
      .map((operation) => operation.setArg ?? {});
  }

  function jobOutcomeInsert() {
    return insertValues().find((values) => "outcomeStatus" in values) as
      | Record<string, any>
      | undefined;
  }

  async function runLlmJob(jobOverrides: Record<string, unknown> = {}) {
    queueDbResults([{ id: "job-1" }], [{ id: "exec-1" }]);
    const { executeJob } = await import("./execute-job.js");
    return executeJob(
      baseJob({
        script: null,
        playbook: "Check for new signups. Stay silent when there is nothing new.",
        channelId: "C123",
        cronSchedule: "0 9 * * *",
        ...jobOverrides,
      }) as any,
      "heartbeat",
    );
  }

  it("completes a clean no-op (final text exactly NO_OP, no posting tools) with the honest marker", async () => {
    const { NO_OP_RESULT_MARKER } = await import("./execute-job.js");
    mockAgentGenerate("NO_OP", [
      {
        finishReason: "stop",
        text: "NO_OP",
        toolCalls: [{ toolName: "bigquery_query", input: { query: "select 1" } }],
        toolResults: [{ toolName: "bigquery_query", output: { rows: [] } }],
      },
    ]);

    await expect(runLlmJob()).resolves.toBe(true);

    const setArgs = updateSetArgs();
    expect(setArgs.find((arg) => "summary" in arg)).toMatchObject({
      status: "completed",
      summary: NO_OP_RESULT_MARKER,
    });
    expect(setArgs.find((arg) => "lastResult" in arg)).toMatchObject({
      status: "pending",
      lastResult: NO_OP_RESULT_MARKER,
    });

    expect(jobOutcomeInsert()).toMatchObject({
      outcomeStatus: "succeeded",
      output: expect.objectContaining({
        type: "llm",
        final_message: "NO_OP",
        no_op: true,
      }),
    });

    const { logger } = await import("../lib/logger.js");
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalledWith(
      expect.stringContaining("NO_OP sentinel contract violation"),
      expect.anything(),
    );
  });

  it("supports the NO_OP: <reason> variant and records the reason", async () => {
    const { NO_OP_RESULT_MARKER } = await import("./execute-job.js");
    mockAgentGenerate("NO_OP: no new signups today", [
      { finishReason: "stop", text: "NO_OP: no new signups today", toolCalls: [], toolResults: [] },
    ]);

    await expect(runLlmJob()).resolves.toBe(true);

    const expectedMarker = `${NO_OP_RESULT_MARKER} (no new signups today)`;
    const setArgs = updateSetArgs();
    expect(setArgs.find((arg) => "summary" in arg)).toMatchObject({ summary: expectedMarker });
    expect(setArgs.find((arg) => "lastResult" in arg)).toMatchObject({ lastResult: expectedMarker });

    expect(jobOutcomeInsert()?.output).toMatchObject({
      no_op: true,
      no_op_reason: "no new signups today",
    });
  });

  it("does not suppress narration text without the sentinel (sentinel-only contract)", async () => {
    const narration = "Checked signups, nothing new to report today.";
    mockAgentGenerate(narration, [
      { finishReason: "stop", text: narration, toolCalls: [], toolResults: [] },
    ]);

    await expect(runLlmJob()).resolves.toBe(true);

    const setArgs = updateSetArgs();
    expect(setArgs.find((arg) => "summary" in arg)).toMatchObject({ summary: narration });
    expect(setArgs.find((arg) => "lastResult" in arg)).toMatchObject({ lastResult: narration });

    const outcome = jobOutcomeInsert();
    expect(outcome?.output.final_message).toBe(narration);
    expect(outcome?.output.no_op).toBeUndefined();
    expect(outcome?.output.no_op_violation).toBeUndefined();
  });

  it("logs a contract violation when the model posts to Slack and then declares NO_OP", async () => {
    mockAgentGenerate("NO_OP", [
      {
        finishReason: "tool-calls",
        text: "",
        toolCalls: [
          { toolName: "send_channel_message", input: { channel: "C123", text: "nothing new" } },
        ],
        toolResults: [{ toolName: "send_channel_message", output: { ok: true } }],
      },
      { finishReason: "stop", text: "NO_OP", toolCalls: [], toolResults: [] },
    ]);

    await expect(runLlmJob()).resolves.toBe(true);

    const { logger } = await import("../lib/logger.js");
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("NO_OP sentinel contract violation"),
      expect.objectContaining({
        jobId: "job-1",
        executionId: "exec-1",
        postingToolCalls: ["send_channel_message"],
      }),
    );

    // No suppression on violation: result/summary keep the raw final text.
    const setArgs = updateSetArgs();
    expect(setArgs.find((arg) => "summary" in arg)).toMatchObject({ summary: "NO_OP" });
    expect(setArgs.find((arg) => "lastResult" in arg)).toMatchObject({ lastResult: "NO_OP" });

    const outcome = jobOutcomeInsert();
    expect(outcome?.output.no_op_violation).toBe(true);
    expect(outcome?.output.no_op).toBeUndefined();
  });
});

describe("parseContinuationTag (issue #1320)", () => {
  it("returns null for a non-continuation description", async () => {
    const { parseContinuationTag } = await import("./execute-job.js");
    expect(parseContinuationTag("do the thing")).toBeNull();
    expect(parseContinuationTag("mentions [CONTINUE:x] but not at the start")).toBeNull();
  });

  it("treats a tag without a depth suffix as depth 1 (checkpoint_plan / legacy)", async () => {
    const { parseContinuationTag } = await import("./execute-job.js");
    expect(parseContinuationTag("[CONTINUE:migrate-repos] finish the last batch")).toEqual({
      topic: "migrate-repos",
      depth: 1,
    });
  });

  it("parses the :dN depth suffix and strips it from the topic", async () => {
    const { parseContinuationTag } = await import("./execute-job.js");
    expect(
      parseContinuationTag("[CONTINUE:turn-deadline-abc123:d2] resume the work"),
    ).toEqual({ topic: "turn-deadline-abc123", depth: 2 });
  });

  it("keeps colons that are part of the topic itself", async () => {
    const { parseContinuationTag } = await import("./execute-job.js");
    expect(parseContinuationTag("[CONTINUE:ns:my-topic] next")).toEqual({
      topic: "ns:my-topic",
      depth: 1,
    });
    expect(parseContinuationTag("[CONTINUE:ns:my-topic:d3] next")).toEqual({
      topic: "ns:my-topic",
      depth: 3,
    });
  });

  it("clamps a nonsensical d0 to depth 1", async () => {
    const { parseContinuationTag } = await import("./execute-job.js");
    expect(parseContinuationTag("[CONTINUE:topic:d0] next")).toEqual({
      topic: "topic",
      depth: 1,
    });
  });
});

describe("executeJob continuation depth threading (issue #1320)", () => {
  beforeEach(() => {
    dbMock.results = [];
    dbMock.operations = [];
    vi.clearAllMocks();
  });

  async function captureAgentOptions(
    jobOverrides: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    let captured: Record<string, any> | null = null;
    createHeadlessAgentMock.mockImplementation(async (options: Record<string, any>) => {
      captured = options;
      return {
        agent: {
          generate: vi.fn(async () => {
            throw new Error("stop-after-capture");
          }),
        },
        modelId: "test-model",
        getStepModelIds: () => [],
      };
    });
    queueDbResults([{ id: "job-1" }], [{ id: "exec-1" }]);

    const { executeJob } = await import("./execute-job.js");
    await expect(
      executeJob(baseJob({ script: null, ...jobOverrides }) as any, "heartbeat"),
    ).rejects.toThrow("stop-after-capture");

    return captured!;
  }

  it("passes depth 0 for a regular (non-continuation) job", async () => {
    const options = await captureAgentOptions({ description: "do the thing" });
    expect(options.continuationDepth).toBe(0);
  });

  it("passes depth 1 for a legacy continuation tag without a suffix", async () => {
    const options = await captureAgentOptions({
      description: "[CONTINUE:migrate-repos] finish the last batch",
    });
    expect(options.continuationDepth).toBe(1);
  });

  it("passes the parsed depth for a :dN-tagged continuation", async () => {
    const options = await captureAgentOptions({
      description: "[CONTINUE:turn-deadline-abc123:d2] resume the work",
    });
    expect(options.continuationDepth).toBe(2);
  });
});

describe("parseNoOpSentinel", () => {
  it("matches exactly NO_OP (with surrounding whitespace allowed)", async () => {
    const { parseNoOpSentinel } = await import("./execute-job.js");
    expect(parseNoOpSentinel("NO_OP")).toEqual({ reason: null });
    expect(parseNoOpSentinel("  NO_OP\n")).toEqual({ reason: null });
  });

  it("captures the optional one-line reason", async () => {
    const { parseNoOpSentinel } = await import("./execute-job.js");
    expect(parseNoOpSentinel("NO_OP: no new signups today")).toEqual({
      reason: "no new signups today",
    });
    expect(parseNoOpSentinel("NO_OP:")).toEqual({ reason: null });
  });

  it("rejects anything that is not the bare sentinel", async () => {
    const { parseNoOpSentinel } = await import("./execute-job.js");
    expect(parseNoOpSentinel("Checked X, nothing new. NO_OP")).toBeNull();
    expect(parseNoOpSentinel("NO_OPS")).toBeNull();
    expect(parseNoOpSentinel("no_op")).toBeNull();
    expect(parseNoOpSentinel("NO_OP: reason\nsecond line")).toBeNull();
    expect(parseNoOpSentinel("")).toBeNull();
    expect(parseNoOpSentinel(null)).toBeNull();
  });
});

describe("findSlackPostingToolCalls", () => {
  it("flags all direct Slack-posting tools and ignores non-posting tools", async () => {
    const { findSlackPostingToolCalls } = await import("./execute-job.js");
    const steps = [
      {
        toolCalls: [
          { toolName: "bigquery_query", input: {} },
          { toolName: "send_thread_reply", input: { channel: "C1", thread_ts: "1.2" } },
          { toolName: "draw_chart", input: {} },
        ],
      },
      { toolCalls: [{ toolName: "send_direct_message", input: { user: "U1" } }] },
      {},
    ];
    expect(findSlackPostingToolCalls(steps)).toEqual([
      "send_thread_reply",
      "draw_chart",
      "send_direct_message",
    ]);
  });

  it("counts upload_file only when it targets a channel (explicit or job fallback)", async () => {
    const { findSlackPostingToolCalls } = await import("./execute-job.js");
    const uploadWithout = [{ toolCalls: [{ toolName: "upload_file", input: { filename: "a.csv" } }] }];
    const uploadWith = [
      { toolCalls: [{ toolName: "upload_file", input: { filename: "a.csv", channel: "C1" } }] },
    ];

    expect(findSlackPostingToolCalls(uploadWithout)).toEqual([]);
    expect(findSlackPostingToolCalls(uploadWithout, "C_JOB")).toEqual(["upload_file"]);
    expect(findSlackPostingToolCalls(uploadWith)).toEqual(["upload_file"]);
  });
});

describe("executeJob scoped execution (issue #1302)", () => {
  beforeEach(() => {
    dbMock.results = [];
    dbMock.operations = [];
    vi.clearAllMocks();
  });

  async function captureAgentOptions(
    jobOverrides: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    let captured: Record<string, any> | null = null;
    createHeadlessAgentMock.mockImplementation(async (options: Record<string, any>) => {
      captured = options;
      return {
        agent: {
          generate: vi.fn(async () => {
            throw new Error("stop-after-capture");
          }),
        },
        modelId: "test-model",
        getStepModelIds: () => [],
      };
    });
    queueDbResults([{ id: "job-1" }], [{ id: "exec-1" }]);

    const { executeJob } = await import("./execute-job.js");
    await expect(
      executeJob(baseJob({ script: null, ...jobOverrides }) as any, "heartbeat"),
    ).rejects.toThrow("stop-after-capture");

    return captured!;
  }

  it("prompt_mode 'task' assembles the system prompt without the personality prefix", async () => {
    const options = await captureAgentOptions({ promptMode: "task" });

    expect(options.systemPrompt).toContain("minimal task prefix");
    expect(options.systemPrompt).not.toContain("full stable prefix");
    expect(buildTaskPrefixMock).toHaveBeenCalled();
    expect(buildStablePrefixMock).not.toHaveBeenCalled();
  });

  it("null prompt_mode keeps today's full stable prefix", async () => {
    const options = await captureAgentOptions({ promptMode: null });

    expect(options.systemPrompt).toContain("full stable prefix");
    expect(options.systemPrompt).not.toContain("minimal task prefix");
    expect(buildTaskPrefixMock).not.toHaveBeenCalled();
  });

  it("routes the headless agent to the job's model category", async () => {
    const options = await captureAgentOptions({ model: "fast" });

    expect(options.modelCategory).toBe("fast");
  });

  it("keeps an explicit 'main' opt-in on the main category", async () => {
    const options = await captureAgentOptions({ model: "main" });

    expect(options.modelCategory).toBe("main");
  });

  it("defaults to the medium category when model is null", async () => {
    const options = await captureAgentOptions({ model: null });

    expect(options.modelCategory).toBe("medium");
  });

  it("falls back to medium for a model value outside the routable categories", async () => {
    const options = await captureAgentOptions({ model: "embedding" });

    expect(options.modelCategory).toBe("medium");
  });

  it("carries the env allowlist into the execution context for the agent loop", async () => {
    const { executionContext } = await import("../lib/tool.js");
    let storeDuringGenerate: Record<string, any> | undefined;
    createHeadlessAgentMock.mockResolvedValue({
      agent: {
        generate: vi.fn(async () => {
          storeDuringGenerate = executionContext.getStore() as Record<string, any>;
          throw new Error("stop-after-capture");
        }),
      },
      modelId: "test-model",
      getStepModelIds: () => [],
    });
    queueDbResults([{ id: "job-1" }], [{ id: "exec-1" }]);

    const { executeJob } = await import("./execute-job.js");
    await expect(
      executeJob(
        baseJob({ script: null, envAllowlist: ["META_ADMIN_TOKEN"] }) as any,
        "heartbeat",
      ),
    ).rejects.toThrow("stop-after-capture");

    expect(storeDuringGenerate?.envAllowlist).toEqual(["META_ADMIN_TOKEN"]);
  });

  it("activates the env allowlist and job-owner scoping during agent/tool construction (issue #1312)", async () => {
    const { executionContext } = await import("../lib/tool.js");
    let storeDuringAgentCreation: Record<string, any> | undefined;
    createHeadlessAgentMock.mockImplementation(async () => {
      storeDuringAgentCreation = executionContext.getStore() as Record<string, any>;
      return {
        agent: {
          generate: vi.fn(async () => {
            throw new Error("stop-after-capture");
          }),
        },
        modelId: "test-model",
        getStepModelIds: () => [],
      };
    });
    queueDbResults([{ id: "job-1" }], [{ id: "exec-1" }]);

    const { executeJob } = await import("./execute-job.js");
    await expect(
      executeJob(
        baseJob({ script: null, envAllowlist: ["META_ADMIN_TOKEN"] }) as any,
        "heartbeat",
      ),
    ).rejects.toThrow("stop-after-capture");

    // Tool building (createSlackTools → resolveUserCredentials) runs inside
    // the job execution context, so credential-gated typed tools are filtered
    // against the allowlist and resolve as the job owner — not any ambient
    // dispatcher context.
    expect(storeDuringAgentCreation?.envAllowlist).toEqual(["META_ADMIN_TOKEN"]);
    expect(storeDuringAgentCreation?.callingUserId).toBe("U_REQUESTER");
    expect(storeDuringAgentCreation?.jobExecutionId).toBe("exec-1");
  });

  it("filters script-layer envs through the job's allowlist", async () => {
    sandboxMock.getSandboxEnvs.mockResolvedValue({
      META_ADMIN_TOKEN: "meta-secret",
      GITHUB_TOKEN: "github-secret",
    });
    sandboxMock.getOrCreateSandbox.mockResolvedValue({
      commands: { run: sandboxMock.commandRun },
    });
    sandboxMock.commandRun.mockResolvedValue({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    queueDbResults([{ id: "job-1" }], [{ id: "exec-1" }]);

    const { executeJob } = await import("./execute-job.js");
    await expect(
      executeJob(
        baseJob({ envAllowlist: ["META_ADMIN_TOKEN"] }) as any,
        "heartbeat",
      ),
    ).resolves.toBe(true);

    expect(sandboxMock.filterEnvsByAllowlist).toHaveBeenCalledWith(
      { META_ADMIN_TOKEN: "meta-secret", GITHUB_TOKEN: "github-secret" },
      ["META_ADMIN_TOKEN"],
    );
    expect(sandboxMock.commandRun).toHaveBeenCalledWith(
      "node script.js",
      expect.objectContaining({
        envs: { META_ADMIN_TOKEN: "meta-secret" },
      }),
    );
  });

  it("script layer keeps the full env when the job has no allowlist", async () => {
    sandboxMock.getSandboxEnvs.mockResolvedValue({
      META_ADMIN_TOKEN: "meta-secret",
      GITHUB_TOKEN: "github-secret",
    });
    sandboxMock.getOrCreateSandbox.mockResolvedValue({
      commands: { run: sandboxMock.commandRun },
    });
    sandboxMock.commandRun.mockResolvedValue({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    queueDbResults([{ id: "job-1" }], [{ id: "exec-1" }]);

    const { executeJob } = await import("./execute-job.js");
    await expect(executeJob(baseJob() as any, "heartbeat")).resolves.toBe(true);

    expect(sandboxMock.commandRun).toHaveBeenCalledWith(
      "node script.js",
      expect.objectContaining({
        envs: {
          META_ADMIN_TOKEN: "meta-secret",
          GITHUB_TOKEN: "github-secret",
        },
      }),
    );
  });
});

describe("executeJob required-credential availability (issue #1344)", () => {
  beforeEach(() => {
    dbMock.results = [];
    dbMock.operations = [];
    vi.clearAllMocks();
    sandboxMock.getSandboxEnvs.mockResolvedValue({});
    sandboxMock.getOrCreateSandbox.mockResolvedValue({
      commands: { run: sandboxMock.commandRun },
    });
  });

  it("fails the run before executing anything and sends an ops notice naming the credential and the owner", async () => {
    // The job owner (a non-admin) cannot access the admin-scoped credential.
    resolveUserCredentialsMock.mockResolvedValue(new Set(["tavily_api_key"]));
    queueDbResults(
      [{ id: "job-1" }], // claim
      [{ id: "exec-1" }], // execution trace insert
      [{ id: "cred-admin", name: "meta_admin_token", scope: "admin", ownerId: "U_ADMIN" }],
    );

    const { executeJob } = await import("./execute-job.js");
    await expect(
      executeJob(
        baseJob({ requiredCredentialIds: ["cred-admin"] }) as any,
        "heartbeat",
      ),
    ).rejects.toThrow(/meta_admin_token/);

    // Ops notice is actionable: names the credential AND the job owner.
    expect(sendJobOpsNoticeMock).toHaveBeenCalledTimes(1);
    const notice = sendJobOpsNoticeMock.mock.calls[0][0] as Record<string, any>;
    expect(notice).toMatchObject({
      jobId: "job-1",
      jobName: "test-job",
      requestedBy: "U_REQUESTER",
    });
    expect(notice.text).toContain("meta_admin_token");
    expect(notice.text).toContain("U_REQUESTER");
    expect(notice.text).toContain("U_ADMIN");

    // Fails closed: neither the script layer nor the agent ever ran.
    expect(sandboxMock.getOrCreateSandbox).not.toHaveBeenCalled();
    expect(sandboxMock.commandRun).not.toHaveBeenCalled();
    expect(createHeadlessAgentMock).not.toHaveBeenCalled();

    // The execution trace records the failure with the same actionable error.
    const failedUpdate = dbMock.operations
      .filter((operation) => operation.kind === "update")
      .map((operation) => operation.setArg ?? {})
      .find((setArg) => setArg.status === "failed" && "error" in setArg);
    expect(String(failedUpdate?.error)).toContain("meta_admin_token");
  });

  it("pins credential resolution to the job owner", async () => {
    resolveUserCredentialsMock.mockResolvedValue(new Set<string>());
    queueDbResults(
      [{ id: "job-1" }],
      [{ id: "exec-1" }],
      [{ id: "cred-admin", name: "meta_admin_token", scope: "admin", ownerId: "U_ADMIN" }],
    );

    const { executeJob } = await import("./execute-job.js");
    await expect(
      executeJob(
        baseJob({ requiredCredentialIds: ["cred-admin"] }) as any,
        "heartbeat",
      ),
    ).rejects.toThrow(/not available to job owner U_REQUESTER/);

    expect(resolveUserCredentialsMock).toHaveBeenCalledWith("U_REQUESTER");
  });

  it("fails with an explicit message when a required credential no longer exists", async () => {
    resolveUserCredentialsMock.mockResolvedValue(new Set(["anything"]));
    queueDbResults(
      [{ id: "job-1" }],
      [{ id: "exec-1" }],
      [], // credential lookup finds nothing — deleted credential
    );

    const { executeJob } = await import("./execute-job.js");
    await expect(
      executeJob(
        baseJob({ requiredCredentialIds: ["cred-gone"] }) as any,
        "heartbeat",
      ),
    ).rejects.toThrow(/cred-gone no longer exists/);

    expect(sendJobOpsNoticeMock).toHaveBeenCalledTimes(1);
  });

  it("proceeds normally when all required credentials are accessible to the job owner", async () => {
    resolveUserCredentialsMock.mockResolvedValue(new Set(["meta_admin_token"]));
    createHeadlessAgentMock.mockResolvedValue({
      agent: {
        generate: vi.fn(async () => {
          throw new Error("stop-after-capture");
        }),
      },
      modelId: "test-model",
      getStepModelIds: () => [],
    });
    queueDbResults(
      [{ id: "job-1" }],
      [{ id: "exec-1" }],
      [{ id: "cred-admin", name: "meta_admin_token", scope: "admin", ownerId: "U_ADMIN" }],
    );

    const { executeJob } = await import("./execute-job.js");
    await expect(
      executeJob(
        baseJob({ script: null, requiredCredentialIds: ["cred-admin"] }) as any,
        "heartbeat",
      ),
    ).rejects.toThrow("stop-after-capture");

    expect(sendJobOpsNoticeMock).not.toHaveBeenCalled();
    expect(createHeadlessAgentMock).toHaveBeenCalled();
  });

  it("skips the check entirely for jobs without required credentials", async () => {
    sandboxMock.commandRun.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    queueDbResults([{ id: "job-1" }], [{ id: "exec-1" }]);

    const { executeJob } = await import("./execute-job.js");
    await expect(executeJob(baseJob() as any, "heartbeat")).resolves.toBe(true);

    expect(resolveUserCredentialsMock).not.toHaveBeenCalled();
    expect(sendJobOpsNoticeMock).not.toHaveBeenCalled();
  });
});

describe("detectScriptOutputError", () => {
  it("returns null for clean stdout with no error envelope", () => {
    const output = '{"status": "ok", "count": 42}\nDone processing.';
    expect(detectScriptOutputError(output)).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(detectScriptOutputError("")).toBeNull();
  });

  it('detects {"error": "..."} envelope', () => {
    const output = 'Starting job...\n{"error": "connection refused"}\n';
    const result = detectScriptOutputError(output);
    expect(result).toBe("connection refused");
  });

  it('detects {"error": {...}} envelope with object value', () => {
    const output = '{"error": {"code": 500, "message": "internal"}}';
    const result = detectScriptOutputError(output);
    expect(result).toContain("500");
    expect(result).toContain("internal");
  });

  it('detects {"ok": false} envelope', () => {
    const output = '{"ok": false, "error": "timeout exceeded"}';
    const result = detectScriptOutputError(output);
    expect(result).toBe("timeout exceeded");
  });

  it('detects {"ok": false} without error field', () => {
    const output = '{"ok": false, "data": null}';
    const result = detectScriptOutputError(output);
    expect(result).toBe("Script returned {ok: false}");
  });

  it("ignores ok: true even with error-like fields", () => {
    const output = '{"ok": true, "error": null}';
    expect(detectScriptOutputError(output)).toBeNull();
  });

  it("ignores non-JSON lines", () => {
    const output = "ERROR: something went wrong\nTraceback follows...";
    expect(detectScriptOutputError(output)).toBeNull();
  });

  it("ignores arrays and non-object JSON", () => {
    const output = '[{"error": "inside array"}]\n"just a string"';
    expect(detectScriptOutputError(output)).toBeNull();
  });

  it("picks up the first error line when multiple exist", () => {
    const output = '{"ok": true}\n{"error": "first error"}\n{"error": "second"}';
    expect(detectScriptOutputError(output)).toBe("first error");
  });

  it("ignores malformed JSON that starts with {", () => {
    const output = '{not valid json at all}\n{"status": "ok"}';
    expect(detectScriptOutputError(output)).toBeNull();
  });

  it('does not treat {"error": ""} (empty string) as an error', () => {
    const output = '{"error": ""}';
    expect(detectScriptOutputError(output)).toBeNull();
  });

  it('does not treat {"error": 0} (falsy) as an error', () => {
    const output = '{"error": 0}';
    expect(detectScriptOutputError(output)).toBeNull();
  });
});
