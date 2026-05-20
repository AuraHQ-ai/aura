import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const state = {
    updateReturningResults: [] as unknown[][],
    insertReturningResults: [] as unknown[][],
    selectResults: [] as unknown[][],
    updateCalls: [] as Array<{ table: unknown; setValues?: Record<string, unknown> }>,
    insertCalls: [] as Array<{ table: unknown; values?: Record<string, unknown> }>,
    update: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
  };

  function createQuery(
    call: { table: unknown; setValues?: Record<string, unknown>; values?: Record<string, unknown> },
    results: unknown[][],
  ) {
    const query: any = {
      set: vi.fn((values: Record<string, unknown>) => {
        call.setValues = values;
        return query;
      }),
      values: vi.fn((values: Record<string, unknown>) => {
        call.values = values;
        return query;
      }),
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn(() => query),
      returning: vi.fn(() => Promise.resolve(results.shift() ?? [])),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(results.shift() ?? []).then(onFulfilled, onRejected),
    };
    return query;
  }

  state.update.mockImplementation((table: unknown) => {
    const call = { table };
    state.updateCalls.push(call);
    return createQuery(call, state.updateReturningResults);
  });

  state.insert.mockImplementation((table: unknown) => {
    const call = { table };
    state.insertCalls.push(call);
    return createQuery(call, state.insertReturningResults);
  });

  state.select.mockImplementation(() => {
    const call = { table: undefined };
    return createQuery(call, state.selectResults);
  });

  return state;
});

const commandRunMock = vi.hoisted(() => vi.fn());
const getOrCreateSandboxMock = vi.hoisted(() => vi.fn());
const getSandboxEnvsMock = vi.hoisted(() => vi.fn());
const truncateOutputMock = vi.hoisted(() => vi.fn((output: string, maxChars = 4000) => output.slice(0, maxChars)));
const createHeadlessAgentMock = vi.hoisted(() => vi.fn());
const agentGenerateMock = vi.hoisted(() => vi.fn());
const persistConversationInputsMock = vi.hoisted(() => vi.fn());

vi.mock("../db/client.js", () => ({
  db: {
    update: dbMock.update,
    insert: dbMock.insert,
    select: dbMock.select,
  },
}));

vi.mock("../lib/sandbox.js", () => ({
  getOrCreateSandbox: getOrCreateSandboxMock,
  getSandboxEnvs: getSandboxEnvsMock,
  truncateOutput: truncateOutputMock,
}));

vi.mock("../lib/agents.js", () => ({
  createHeadlessAgent: createHeadlessAgentMock,
}));

vi.mock("../lib/tool.js", () => ({
  executionContext: {
    run: vi.fn((_context, callback) => callback()),
  },
}));

vi.mock("../personality/system-prompt.js", () => ({
  buildStablePrefix: vi.fn().mockResolvedValue("stable-prefix"),
}));

vi.mock("../lib/temporal.js", () => ({
  getCurrentTimeContext: vi.fn(() => "time-context"),
}));

vi.mock("./persist-conversation.js", () => ({
  createConversationTrace: vi.fn().mockResolvedValue("conversation-1"),
  persistConversationInputs: persistConversationInputsMock,
  persistConversationSteps: vi.fn().mockResolvedValue(undefined),
  persistConversationError: vi.fn().mockResolvedValue(undefined),
  updateConversationTraceUsage: vi.fn().mockResolvedValue(undefined),
  buildConversationSteps: vi.fn(() => []),
}));

vi.mock("../lib/cost-calculator.js", () => ({
  buildStepUsages: vi.fn(() => []),
}));

vi.mock("../tools/scratchpad.js", () => ({
  getScratchpadContents: vi.fn(() => undefined),
  cleanupScratchpad: vi.fn(),
}));

vi.mock("../tools/slack.js", () => ({
  resolveSlackDestination: vi.fn().mockResolvedValue(null),
}));

vi.mock("../lib/slack-messaging.js", () => ({
  safePostMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { errorEvents } from "@aura/db/schema";
import { executeJob, MAX_RETRIES } from "./execute-job.js";

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    workspaceId: "default",
    name: "sync-meta-comments-daily",
    description: "Sync Meta comments",
    playbook: "Summarize script output",
    script: "python sync-meta-comments.py",
    cronSchedule: null,
    frequencyConfig: null,
    channelId: "C123",
    threadTs: null,
    executeAt: new Date(),
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
    requiredCredentialIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any;
}

function resetDbQueues() {
  dbMock.updateReturningResults = [[{ id: "job-1" }]];
  dbMock.insertReturningResults = [[{ id: "execution-1" }]];
  dbMock.selectResults = [];
  dbMock.updateCalls = [];
  dbMock.insertCalls = [];
}

function failedJobUpdate() {
  return dbMock.updateCalls.find((call) => call.setValues?.status === "failed" && "retries" in call.setValues);
}

describe("executeJob script failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbQueues();
    getOrCreateSandboxMock.mockResolvedValue({ commands: { run: commandRunMock } });
    getSandboxEnvsMock.mockResolvedValue({});
    persistConversationInputsMock.mockResolvedValue(2);
    agentGenerateMock.mockResolvedValue({
      text: "LLM completed",
      steps: [],
      totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    createHeadlessAgentMock.mockResolvedValue({
      agent: { generate: agentGenerateMock },
      modelId: "test-model",
      getStepModelIds: () => [],
    });
  });

  it("marks exit code 127 as failed, increments retries, and does not invoke the LLM", async () => {
    commandRunMock.mockResolvedValue({
      exitCode: 127,
      stdout: "",
      stderr: "python: command not found",
    });

    await expect(executeJob(baseJob({ retries: MAX_RETRIES - 1 }))).rejects.toMatchObject({
      name: "ScriptHardFailure",
      exitCode: 127,
    });

    expect(createHeadlessAgentMock).not.toHaveBeenCalled();
    expect(agentGenerateMock).not.toHaveBeenCalled();
    expect(failedJobUpdate()?.setValues).toMatchObject({
      status: "failed",
      retries: MAX_RETRIES,
    });
    expect(
      dbMock.insertCalls.some(
        (call) =>
          call.table === errorEvents &&
          call.values?.errorName === "ScriptHardFailure" &&
          call.values?.errorCode === "SCRIPT_EXIT_127",
      ),
    ).toBe(true);
  });

  it("falls through to the LLM with partial stdout and stderr for soft failures", async () => {
    commandRunMock.mockResolvedValue({
      exitCode: 1,
      stdout: '{"partial":true}',
      stderr: "API returned partial data before failing",
    });

    await expect(executeJob(baseJob())).resolves.toBe(true);

    expect(createHeadlessAgentMock).toHaveBeenCalledOnce();
    expect(agentGenerateMock).toHaveBeenCalledOnce();
    const prompt = agentGenerateMock.mock.calls[0][0].prompt;
    expect(prompt).toContain('{"partial":true}');
    expect(prompt).toContain("## Script stderr");
    expect(prompt).toContain("API returned partial data before failing");
  });

  it("treats thrown script errors with no stdout as hard failures", async () => {
    commandRunMock.mockRejectedValue(new Error("Command timed out"));

    await expect(executeJob(baseJob({ retries: MAX_RETRIES - 1 }))).rejects.toMatchObject({
      name: "ScriptHardFailure",
      exitCode: 1,
    });

    expect(createHeadlessAgentMock).not.toHaveBeenCalled();
    expect(agentGenerateMock).not.toHaveBeenCalled();
    expect(failedJobUpdate()?.setValues).toMatchObject({
      status: "failed",
      retries: MAX_RETRIES,
    });
  });
});
