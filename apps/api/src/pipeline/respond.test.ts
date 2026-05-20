import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentMocks = vi.hoisted(() => ({
  createInteractiveAgent: vi.fn(),
}));

vi.mock("ai", () => ({
  streamText: vi.fn(),
}));

vi.mock("../lib/agents.js", () => ({
  createInteractiveAgent: agentMocks.createInteractiveAgent,
}));

vi.mock("../lib/ai.js", () => ({
  getMainModel: vi.fn(),
  buildCachedSystemMessages: vi.fn(),
}));

vi.mock("../lib/tool.js", () => ({
  getSlackMeta: (tool: any) => tool?.slack,
}));

vi.mock("../lib/settings.js", () => ({
  getSettingJSON: vi.fn().mockResolvedValue("timeline"),
}));

vi.mock("../lib/slack-status.js", () => ({
  trySetAssistantThreadStatus: vi.fn().mockResolvedValue(undefined),
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
  logError: vi.fn(),
}));

vi.mock("../tools/scratchpad.js", () => ({
  cleanupScratchpad: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../tools/table.js", () => ({
  TABLE_BLOCK_KEY: "__table_block",
}));

vi.mock("./prepare-step.js", () => ({
  InvocationSupersededError: class InvocationSupersededError extends Error {
    invocationId = "test-invocation";
  },
}));

import { generateResponse } from "./respond.js";
import { logError } from "../lib/error-logger.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createSlackClient(streamers: Array<{ append: any; stop: any }>) {
  return {
    chatStream: vi.fn(() => {
      const next = streamers.shift();
      if (!next) throw new Error("No streamers left");
      return next;
    }),
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "fallback-ts", channel: "C123" }),
    },
  };
}

function mockAgentStream(fullStream: AsyncIterable<any>) {
  agentMocks.createInteractiveAgent.mockResolvedValue({
    agent: {
      stream: vi.fn().mockResolvedValue({
        fullStream,
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
        finishReason: Promise.resolve("stop"),
        steps: Promise.resolve([]),
      }),
    },
    tools: {
      run_command: {
        slack: {
          status: "Running a command in the sandbox...",
        },
      },
    },
    modelId: "test-model",
    getStepModelIds: () => ["test-model"],
  });
}

function baseOptions(slackClient: any) {
  return {
    stablePrefix: "",
    conversationContext: "",
    userMessage: "run a slow command",
    slackClient,
    channelId: "C123",
    threadTs: "1710000000.000000",
    teamId: "T123",
    recipientUserId: "U123",
  };
}

describe("generateResponse Slack stream handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("splits to a new stream with a tombstone when a tool call exceeds 75 seconds", async () => {
    vi.useFakeTimers();
    const finishTool = deferred<void>();
    const firstStream = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const secondStream = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([firstStream, secondStream]);

    mockAgentStream((async function* () {
      yield {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "run_command",
        input: { command: "sleep 200", timeout_seconds: 200 },
      };
      await finishTool.promise;
      yield {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "run_command",
        output: { ok: true, exit_code: 0, stdout: "", stderr: "" },
      };
      yield { type: "text-delta", text: "Done." };
    })());

    const responsePromise = generateResponse(baseOptions(slackClient));
    await vi.advanceTimersByTimeAsync(0);

    expect(firstStream.append).toHaveBeenCalledWith({
      chunks: [expect.objectContaining({
        type: "task_update",
        id: "call-1",
        status: "in_progress",
      })],
    });

    await vi.advanceTimersByTimeAsync(75_000);

    expect(slackClient.chatStream).toHaveBeenCalledTimes(2);
    expect(firstStream.append).toHaveBeenCalledWith({
      chunks: expect.arrayContaining([
        expect.objectContaining({
          type: "task_update",
          id: "call-1",
          status: "complete",
          output: "continuing in a new message...",
        }),
        expect.objectContaining({
          type: "markdown_text",
          text: expect.stringContaining("continuing in a new message"),
        }),
      ]),
    });
    expect(firstStream.stop).toHaveBeenCalled();

    finishTool.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(responsePromise).resolves.toMatchObject({
      raw: "Done.",
      alreadyPosted: true,
    });
    expect(secondStream.append).toHaveBeenCalledWith({
      chunks: [expect.objectContaining({
        type: "task_update",
        id: "call-1",
        status: "complete",
      })],
    });
  });

  it("stops a failed stream with a continuation tombstone before postMessage fallback", async () => {
    const stream = {
      append: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(Object.assign(new Error("invalid_blocks"), {
          data: { error: "invalid_blocks" },
        })),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);

    mockAgentStream((async function* () {
      yield {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "run_command",
        input: { command: "true" },
      };
      yield {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "run_command",
        output: { ok: true, exit_code: 0, stdout: "", stderr: "" },
      };
      yield { type: "text-delta", text: "Fallback text." };
    })());

    await generateResponse(baseOptions(slackClient));

    expect(stream.stop).toHaveBeenCalledWith({
      chunks: expect.arrayContaining([
        expect.objectContaining({
          type: "task_update",
          id: "call-1",
          status: "complete",
          output: "continuing in a new message...",
        }),
        expect.objectContaining({
          type: "markdown_text",
          text: expect.stringContaining("continuing in a new message"),
        }),
      ]),
    });
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C123",
      thread_ts: "1710000000.000000",
      text: expect.stringContaining("Fallback text."),
    }));
  });

  it("logs empty completions after tool errors without recording unexpected stream errors", async () => {
    const stream = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);

    mockAgentStream((async function* () {
      yield {
        type: "tool-error",
        toolCallId: "call-1",
        toolName: "run_command",
        error: new Error("sandbox died"),
      };
    })());

    await generateResponse(baseOptions(slackClient));

    const logErrorMock = vi.mocked(logError);
    const emptyCompletionLogs = logErrorMock.mock.calls.filter(
      ([entry]) => entry.errorCode === "empty_completion_after_tools",
    );
    const unexpectedStreamLogs = logErrorMock.mock.calls.filter(
      ([entry]) => entry.errorName === "UnexpectedStreamError",
    );

    expect(emptyCompletionLogs).toHaveLength(1);
    expect(emptyCompletionLogs[0]?.[0]).toMatchObject({
      errorName: "EmptyCompletion",
      errorCode: "empty_completion_after_tools",
      channelId: "C123",
      context: {
        toolCallCount: 1,
        toolErrorCount: 1,
        finishReason: "stop",
      },
    });
    expect(unexpectedStreamLogs).toHaveLength(0);
    expect(stream.stop).toHaveBeenCalledWith({
      chunks: [expect.objectContaining({
        type: "markdown_text",
        text: expect.stringContaining("no output generated"),
      })],
    });
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C123",
      thread_ts: "1710000000.000000",
      text: "_I ran the tools but didn't get usable output back. Can you tell me what to retry?_",
    }));
  });
});
