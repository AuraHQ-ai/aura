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
import { logger } from "../lib/logger.js";

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

function createAgentStreamResult(
  fullStream: AsyncIterable<any>,
  options: {
    text?: string;
    finishReason?: string;
    responseMessages?: any[];
    usage?: any;
    steps?: any[];
  } = {},
) {
  return {
    fullStream,
    usage: Promise.resolve(options.usage ?? { inputTokens: 1, outputTokens: 1 }),
    finishReason: Promise.resolve(options.finishReason ?? "stop"),
    text: Promise.resolve(options.text ?? ""),
    response: Promise.resolve({ messages: options.responseMessages ?? [] }),
    steps: Promise.resolve(options.steps ?? []),
  };
}

function mockAgentStreams(results: any[]) {
  const stream = vi.fn();
  for (const result of results) {
    stream.mockResolvedValueOnce(result);
  }
  agentMocks.createInteractiveAgent.mockResolvedValue({
    agent: {
      stream,
    },
    tools: {
      run_command: {
        slack: {
          status: "Running a command in the sandbox...",
          detail: (input: any) => input.command,
        },
      },
    },
    modelId: "test-model",
    getStepModelIds: () => ["test-model"],
  });
  return stream;
}

function mockAgentStream(
  fullStream: AsyncIterable<any>,
  options: Parameters<typeof createAgentStreamResult>[1] = {},
) {
  return mockAgentStreams([createAgentStreamResult(fullStream, options)]);
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

  it("emits an optimistic tool card on tool-input-start and updates it on tool-call", async () => {
    const stream = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);

    mockAgentStream((async function* () {
      yield {
        type: "tool-input-start",
        toolCallId: "call-1",
        toolName: "run_command",
      };
      yield {
        type: "tool-input-delta",
        toolCallId: "call-1",
        inputTextDelta: "{\"command\":\"echo",
      };
      yield {
        type: "tool-input-delta",
        toolCallId: "call-1",
        inputTextDelta: " ok\"}",
      };
      yield {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "run_command",
        input: { command: "echo ok" },
      };
      yield {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "run_command",
        output: { ok: true, exit_code: 0, stdout: "ok", stderr: "" },
      };
      yield { type: "text-delta", text: "Done." };
    })());

    await generateResponse(baseOptions(slackClient));

    const taskUpdates = stream.append.mock.calls
      .flatMap(([payload]) => payload.chunks ?? [])
      .filter((chunk) => chunk.type === "task_update" && chunk.id === "call-1");
    const inProgressUpdates = taskUpdates.filter((chunk) => chunk.status === "in_progress");

    expect(new Set(inProgressUpdates.map((chunk) => chunk.id))).toEqual(new Set(["call-1"]));
    expect(inProgressUpdates).toHaveLength(2);
    expect(inProgressUpdates[0]).toMatchObject({
      type: "task_update",
      id: "call-1",
      title: "Running a command in the sandbox...",
      status: "in_progress",
    });
    expect(inProgressUpdates[0]).not.toHaveProperty("details");
    expect(inProgressUpdates[1]).toMatchObject({
      type: "task_update",
      id: "call-1",
      title: "Running a command in the sandbox...",
      status: "in_progress",
      details: "echo ok",
    });
  });

  it("terminates an optimistic tool card if the stream errors before tool-call", async () => {
    const stream = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);

    mockAgentStream((async function* () {
      yield {
        type: "tool-input-start",
        toolCallId: "call-1",
        toolName: "run_command",
      };
      throw new Error("tool input failed");
    })());

    await expect(generateResponse(baseOptions(slackClient))).rejects.toThrow("tool input failed");

    expect(stream.append).toHaveBeenCalledWith({
      chunks: [expect.objectContaining({
        type: "task_update",
        id: "call-1",
        status: "in_progress",
      })],
    });
    expect(stream.stop).toHaveBeenCalledWith({
      chunks: expect.arrayContaining([
        expect.objectContaining({
          type: "task_update",
          id: "call-1",
          status: "error",
          output: "tool input failed",
        }),
      ]),
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

  it("does not log message_not_in_streaming_state when postMessage fallback succeeds", async () => {
    const stream = {
      append: vi.fn().mockRejectedValueOnce(Object.assign(new Error("message_not_in_streaming_state"), {
        data: { error: "message_not_in_streaming_state" },
      })),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);

    mockAgentStream((async function* () {
      yield { type: "text-delta", text: "Recovered fallback text." };
    })());

    await generateResponse(baseOptions(slackClient));

    expect(logError).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "chatStream append left streaming state, falling back to postMessage",
      expect.objectContaining({
        channelId: "C123",
        slackError: "message_not_in_streaming_state",
      }),
    );
    expect(stream.stop).toHaveBeenCalledWith({
      chunks: expect.arrayContaining([
        expect.objectContaining({
          type: "markdown_text",
          text: expect.stringContaining("continuing in a new message"),
        }),
      ]),
    });
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C123",
      thread_ts: "1710000000.000000",
      text: expect.stringContaining("Recovered fallback text."),
    }));
  });

  it("does not record an error event when channel_type_not_supported fallback succeeds", async () => {
    const stream = {
      append: vi.fn().mockRejectedValueOnce(Object.assign(new Error("channel_type_not_supported"), {
        data: { error: "channel_type_not_supported" },
      })),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);

    mockAgentStream((async function* () {
      yield { type: "text-delta", text: "Fallback delivered." };
    })());

    await generateResponse({
      ...baseOptions(slackClient),
      channelId: "C_UNSUPPORTED_995",
    });

    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C_UNSUPPORTED_995",
      thread_ts: "1710000000.000000",
      text: expect.stringContaining("Fallback delivered."),
    }));

    const channelTypeLogs = vi.mocked(logError).mock.calls.filter(
      ([entry]) => entry.errorCode === "channel_type_not_supported",
    );
    expect(channelTypeLogs).toHaveLength(0);
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

  it("recovers output from final result.text when streamed text deltas are missing", async () => {
    const stream = {
      append: vi.fn().mockResolvedValue(undefined),
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
        output: { ok: true, exit_code: 0, stdout: "ok", stderr: "" },
      };
    })(), { text: "Recovered summary." });

    await expect(generateResponse(baseOptions(slackClient))).resolves.toMatchObject({
      raw: "Recovered summary.",
      alreadyPosted: true,
    });

    expect(stream.append).toHaveBeenCalledWith({
      chunks: [expect.objectContaining({
        type: "markdown_text",
        text: "Recovered summary.",
      })],
    });
    expect(vi.mocked(logError).mock.calls.some(
      ([entry]) => entry.errorCode === "empty_completion_after_tools",
    )).toBe(false);
    expect(vi.mocked(logError).mock.calls.some(
      ([entry]) => entry.errorCode === "empty_completion_relaunched",
    )).toBe(false);
  });

  it("relaunches once with a synthetic user message after useful tool results produce no text", async () => {
    const stream = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);
    const responseMessages = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "run_command", input: { command: "true" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-1", toolName: "run_command", output: { ok: true } }],
      },
    ];
    const streamMock = mockAgentStreams([
      createAgentStreamResult((async function* () {
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
          output: { ok: true, exit_code: 0, stdout: "ok", stderr: "" },
        };
      })(), { responseMessages }),
      createAgentStreamResult((async function* () {
        yield { type: "text-delta", text: "The command succeeded." };
      })()),
    ]);

    await expect(generateResponse(baseOptions(slackClient))).resolves.toMatchObject({
      raw: "The command succeeded.",
      alreadyPosted: true,
    });

    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(streamMock.mock.calls[1]?.[0]).toMatchObject({
      messages: [
        { role: "user", content: "run a slow command" },
        ...responseMessages,
        { role: "user", content: "(continue - you ended without responding. Summarize what you found.)" },
      ],
    });
    const relaunchLogs = vi.mocked(logError).mock.calls.filter(
      ([entry]) => entry.errorCode === "empty_completion_relaunched",
    );
    expect(relaunchLogs).toHaveLength(1);
    expect(relaunchLogs[0]?.[0]).toMatchObject({
      errorName: "EmptyCompletionRelaunched",
      channelId: "C123",
      context: {
        toolCallCount: 1,
        toolErrorCount: 0,
        finishReason: "stop",
        relaunchCount: 1,
      },
    });
  });

  it("bounds empty-completion relaunches to one attempt", async () => {
    const stream = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);
    const streamMock = mockAgentStreams([
      createAgentStreamResult((async function* () {
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
          output: { ok: true, exit_code: 0, stdout: "ok", stderr: "" },
        };
      })()),
      createAgentStreamResult((async function* () {
        // Empty second attempt.
      })()),
    ]);

    await generateResponse(baseOptions(slackClient));

    expect(streamMock).toHaveBeenCalledTimes(2);
    const logErrorMock = vi.mocked(logError);
    expect(logErrorMock.mock.calls.filter(
      ([entry]) => entry.errorCode === "empty_completion_relaunched",
    )).toHaveLength(1);
    expect(logErrorMock.mock.calls.filter(
      ([entry]) => entry.errorCode === "empty_completion_after_tools",
    )).toHaveLength(1);
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: "_I ran the tools but didn't get usable output back. Can you tell me what to retry?_",
    }));
  });

  it("does not error-log or relaunch superseded empty completions", async () => {
    const stream = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);
    const supersededError = Object.assign(
      new Error("Invocation test-invocation was superseded by a newer message"),
      { name: "InvocationSupersededError", invocationId: "test-invocation" },
    );
    const streamMock = vi.fn().mockImplementation(async (callOptions: any) => createAgentStreamResult((async function* () {
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
        output: { ok: true, exit_code: 0, stdout: "ok", stderr: "" },
      };
      callOptions.onError?.({ error: supersededError });
    })()));
    agentMocks.createInteractiveAgent.mockResolvedValue({
      agent: { stream: streamMock },
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

    await expect(generateResponse(baseOptions(slackClient))).resolves.toMatchObject({
      interrupted: true,
    });

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logError).mock.calls.some(
      ([entry]) => entry.errorCode === "empty_completion_relaunched",
    )).toBe(false);
    expect(vi.mocked(logError).mock.calls.some(
      ([entry]) => entry.errorCode === "empty_completion_after_tools",
    )).toBe(false);
    expect(vi.mocked(logError).mock.calls.some(
      ([entry]) => entry.errorCode === "stream_on_error_callback",
    )).toBe(false);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      "Stream onError ignored — invocation superseded",
      expect.objectContaining({
        channelId: "C123",
      }),
    );
  });

  it("logs empty completions for tool-error-only continuation segments", async () => {
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
      yield { type: "text-delta", text: "Starting the job.\n" };
      yield {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "run_command",
        input: { command: "sleep 200", timeout_seconds: 200 },
      };
      await finishTool.promise;
      yield {
        type: "tool-error",
        toolCallId: "call-1",
        toolName: "run_command",
        error: new Error("sandbox died"),
      };
    })());

    const responsePromise = generateResponse(baseOptions(slackClient));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(75_000);
    expect(slackClient.chatStream).toHaveBeenCalledTimes(2);

    finishTool.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(responsePromise).resolves.toMatchObject({
      raw: "Starting the job.\n",
      alreadyPosted: true,
    });

    const logErrorMock = vi.mocked(logError);
    const continuationLogs = logErrorMock.mock.calls.filter(
      ([entry]) => entry.errorCode === "empty_completion_after_tools_continuation",
    );
    const aggregateLogs = logErrorMock.mock.calls.filter(
      ([entry]) => entry.errorCode === "empty_completion_after_tools",
    );

    expect(continuationLogs).toHaveLength(1);
    expect(continuationLogs[0]?.[0]).toMatchObject({
      errorName: "EmptyCompletion",
      errorCode: "empty_completion_after_tools_continuation",
      channelId: "C123",
      context: {
        toolCallCount: 1,
        toolErrorCount: 1,
        segmentIndex: 1,
        continuationReason: "long_tool",
        segmentEnd: "final",
        finishReason: "stop",
      },
    });
    expect(aggregateLogs).toHaveLength(0);
    expect(secondStream.append).toHaveBeenCalledWith({
      chunks: [expect.objectContaining({
        type: "markdown_text",
        text: expect.stringContaining("no output generated in continuation"),
      })],
    });
  });

  it("logs and tombstones watchdog AbortError streams", async () => {
    vi.useFakeTimers();
    const stream = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);
    const abortError = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
      code: "ABORT_ERR",
    });

    agentMocks.createInteractiveAgent.mockResolvedValue({
      agent: {
        stream: vi.fn().mockImplementation(async (options: { abortSignal: AbortSignal }) => ({
          fullStream: (async function* () {
            await new Promise<void>((_resolve, reject) => {
              if (options.abortSignal.aborted) {
                reject(abortError);
                return;
              }
              options.abortSignal.addEventListener("abort", () => reject(abortError), { once: true });
            });
          })(),
          usage: Promise.resolve({ inputTokens: 1, outputTokens: 0 }),
          finishReason: Promise.resolve("abort"),
          steps: Promise.resolve([]),
        })),
      },
      tools: {},
      modelId: "test-model",
      getStepModelIds: () => ["test-model"],
    });

    const responsePromise = generateResponse(baseOptions(slackClient));
    const responseExpectation = expect(responsePromise).rejects.toMatchObject({
      name: "AbortError",
      code: "ABORT_ERR",
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(180_000);

    await responseExpectation;

    const abortLogs = vi.mocked(logError).mock.calls.filter(
      ([entry]) => entry.errorCode === "stream_aborted_by_watchdog",
    );
    expect(abortLogs).toHaveLength(1);
    expect(abortLogs[0]?.[0]).toMatchObject({
      errorName: "StreamAborted",
      errorCode: "stream_aborted_by_watchdog",
      channelId: "C123",
      context: {
        reason: "inactivity",
        accumulatedTextLength: 0,
        toolCallCount: 0,
        segmentIndex: 0,
      },
    });
    expect(stream.stop).toHaveBeenCalledWith({
      chunks: [expect.objectContaining({
        type: "markdown_text",
        text: expect.stringContaining("[stream aborted: inactivity]"),
      })],
    });
  });
});
