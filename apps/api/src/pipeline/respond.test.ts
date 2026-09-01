import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentMocks = vi.hoisted(() => ({
  createInteractiveAgent: vi.fn(),
}));
const toolStateMocks = vi.hoisted(() => ({
  detachedSuspendState: undefined as { commandId: string } | undefined,
}));
const turnMarkerMocks = vi.hoisted(() => ({
  startTurnMarker: vi.fn().mockResolvedValue(undefined),
  finishTurnMarker: vi.fn().mockResolvedValue(undefined),
}));
const invocationLockMocks = vi.hoisted(() => ({
  isInvocationCurrent: vi.fn(),
  getSupersedeReason: vi.fn(),
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
  getDetachedCommandSuspendState: () => toolStateMocks.detachedSuspendState,
}));

vi.mock("../lib/settings.js", () => ({
  getSettingJSON: vi.fn().mockResolvedValue("timeline"),
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

vi.mock("../lib/turn-markers.js", () => turnMarkerMocks);

vi.mock("../tools/scratchpad.js", () => ({
  cleanupScratchpad: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../tools/table.js", () => ({
  TABLE_BLOCK_KEY: "__table_block",
}));

vi.mock("../tools/chart.js", () => ({
  CHART_BLOCK_KEY: "__chart_block",
}));

vi.mock("../tools/alert.js", () => ({
  ALERT_BLOCK_KEY: "__alert_block",
}));

vi.mock("../tools/card.js", () => ({
  CARD_BLOCK_KEY: "__card_blocks",
}));

vi.mock("./prepare-step.js", () => ({
  InvocationSupersededError: class InvocationSupersededError extends Error {
    invocationId = "test-invocation";
  },
}));

vi.mock("../lib/invocation-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/invocation-lock.js")>();
  return {
    ...actual,
    isInvocationCurrent: invocationLockMocks.isInvocationCurrent,
    getSupersedeReason: invocationLockMocks.getSupersedeReason,
  };
});

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
  stream: AsyncIterable<any>,
  options: {
    text?: string;
    finishReason?: string;
    responseMessages?: any[];
    usage?: any;
    steps?: any[];
  } = {},
) {
  return {
    stream,
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
  stream: AsyncIterable<any>,
  options: Parameters<typeof createAgentStreamResult>[1] = {},
) {
  return mockAgentStreams([createAgentStreamResult(stream, options)]);
}

function baseOptions(slackClient: any) {
  return {
    stablePrefix: "",
    environmentContext: "",
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
    toolStateMocks.detachedSuspendState = undefined;
    invocationLockMocks.isInvocationCurrent.mockResolvedValue(true);
    invocationLockMocks.getSupersedeReason.mockResolvedValue("newer_message");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams native chart blocks returned by draw_chart inline mode", async () => {
    const chartBlock = {
      type: "data_visualization",
      title: "Weekly Sales",
      chart: {
        type: "line",
        series: [{
          name: "Online",
          data: [{ label: "Week 1", value: 12 }],
        }],
        axis_config: { categories: ["Week 1"] },
      },
    };
    const streamer = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([streamer]);

    mockAgentStream((async function* () {
      yield {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "draw_chart",
        output: { ok: true, __chart_block: chartBlock },
      };
      yield { type: "text-delta", text: "Done." };
    })());

    await expect(generateResponse(baseOptions(slackClient))).resolves.toMatchObject({
      raw: "Done.",
      alreadyPosted: true,
    });

    expect(streamer.append).toHaveBeenCalledWith({
      chunks: [{
        type: "blocks",
        blocks: [chartBlock],
      }],
    });

    // Delivery receipt: the block landed via the stream append path.
    expect(logger.info).toHaveBeenCalledWith("NativeBlockDelivered", expect.objectContaining({
      toolCallIds: ["call-1"],
      path: "stream_append",
    }));
  });

  it("streams native alert blocks returned by raise_alert inline mode", async () => {
    const alertBlock = {
      type: "alert",
      text: { type: "mrkdwn", text: "*3 jobs failed* — email-delivery cluster degraded" },
      level: "error",
    };
    const streamer = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([streamer]);

    mockAgentStream((async function* () {
      yield {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "raise_alert",
        output: { ok: true, __alert_block: alertBlock },
      };
      yield { type: "text-delta", text: "Escalating." };
    })());

    await expect(generateResponse(baseOptions(slackClient))).resolves.toMatchObject({
      raw: "Escalating.",
      alreadyPosted: true,
    });

    expect(streamer.append).toHaveBeenCalledWith({
      chunks: [{
        type: "blocks",
        blocks: [alertBlock],
      }],
    });
  });

  it("streams all card blocks returned by draw_cards inline mode in one blocks chunk", async () => {
    const cardBlocks = [
      {
        type: "card",
        title: { type: "mrkdwn", text: "WINS" },
        body: { type: "mrkdwn", text: "Two PRs merged." },
      },
      {
        type: "card",
        title: { type: "mrkdwn", text: "FOLLOW-UPS" },
        body: { type: "mrkdwn", text: "Check gap-issue sync." },
      },
    ];
    const streamer = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([streamer]);

    mockAgentStream((async function* () {
      yield {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "draw_cards",
        output: { ok: true, __card_blocks: cardBlocks },
      };
      yield { type: "text-delta", text: "EOD reflection below." };
    })());

    await expect(generateResponse(baseOptions(slackClient))).resolves.toMatchObject({
      raw: "EOD reflection below.",
      alreadyPosted: true,
    });

    expect(streamer.append).toHaveBeenCalledWith({
      chunks: [{
        type: "blocks",
        blocks: cardBlocks,
      }],
    });
  });

  it("delivers card blocks via chat.postMessage when the stream rejects them", async () => {
    const cardBlocks = [
      {
        type: "card",
        title: { type: "mrkdwn", text: "WINS" },
        body: { type: "mrkdwn", text: "Two PRs merged." },
      },
      {
        type: "card",
        title: { type: "mrkdwn", text: "NOTED" },
        body: { type: "mrkdwn", text: "SEO W30 flat." },
      },
    ];
    const invalidArgumentsError = () =>
      Object.assign(new Error("An API error occurred: invalid_arguments"), {
        data: { error: "invalid_arguments" },
      });
    const streamer = {
      // Reject the inline blocks-chunk append so the cards stay queued as
      // pending native blocks and ride on the stop() payload.
      append: vi.fn(async (payload: any) => {
        if (payload?.chunks?.some((c: any) => c?.type === "blocks")) {
          throw invalidArgumentsError();
        }
      }),
      stop: vi.fn()
        .mockRejectedValueOnce(invalidArgumentsError())
        .mockResolvedValueOnce(undefined),
    };
    const slackClient = createSlackClient([streamer]);

    mockAgentStream((async function* () {
      yield {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "draw_cards",
        output: { ok: true, __card_blocks: cardBlocks },
      };
      yield { type: "text-delta", text: "Digest below." };
    })());

    await expect(generateResponse(baseOptions(slackClient))).resolves.toMatchObject({
      raw: "Digest below.",
      alreadyPosted: true,
    });

    // First stop attempt carries both cards; the retry finalizes without them.
    expect(streamer.stop).toHaveBeenCalledTimes(2);
    expect(streamer.stop.mock.calls[0][0]).toMatchObject({
      blocks: expect.arrayContaining(cardBlocks),
    });

    // Both stripped cards are delivered via the chat.postMessage fallback.
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C123",
      text: "Here's a summary:",
      blocks: cardBlocks,
    }));
  });

  it("recovers when streamer.stop() rejects the block payload with invalid_arguments", async () => {
    const tableBlock = {
      type: "table",
      rows: [[{ type: "raw_text", text: "cell" }]],
    };
    const invalidArgumentsError = () =>
      Object.assign(new Error("An API error occurred: invalid_arguments"), {
        data: { error: "invalid_arguments" },
      });
    const streamer = {
      // Reject the inline blocks-chunk append so the table stays queued as a
      // pending native block and rides on the stop() payload.
      append: vi.fn(async (payload: any) => {
        if (payload?.chunks?.some((c: any) => c?.type === "blocks")) {
          throw invalidArgumentsError();
        }
      }),
      stop: vi.fn()
        .mockRejectedValueOnce(invalidArgumentsError())
        .mockResolvedValueOnce(undefined),
    };
    const slackClient = createSlackClient([streamer]);

    mockAgentStream((async function* () {
      yield {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "draw_table",
        output: { ok: true, __table_block: tableBlock },
      };
      yield { type: "text-delta", text: "Here is the table." };
    })());

    await expect(generateResponse(baseOptions(slackClient))).resolves.toMatchObject({
      raw: "Here is the table.",
      alreadyPosted: true,
    });

    // First stop attempt carries the blocks; the retry finalizes without them.
    expect(streamer.stop).toHaveBeenCalledTimes(2);
    expect(streamer.stop.mock.calls[0][0]).toMatchObject({
      blocks: expect.arrayContaining([tableBlock]),
    });
    expect(streamer.stop.mock.calls[1]).toEqual([]);

    // The stripped table block is delivered via the chat.postMessage fallback.
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C123",
      text: "Here's a table:",
      blocks: [tableBlock],
    }));

    // The original error is logged instead of rethrown.
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({
      errorName: "StreamStopInvalidArguments",
      errorCode: "invalid_arguments",
      context: expect.objectContaining({ phase: "stop" }),
    }));

    // Delivery receipt: the block landed via the postMessage fallback.
    expect(logger.info).toHaveBeenCalledWith("NativeBlockDelivered", expect.objectContaining({
      toolCallIds: ["call-1"],
      path: "post_message_fallback",
    }));
    expect(logError).not.toHaveBeenCalledWith(expect.objectContaining({
      errorName: "NativeBlockDropped",
    }));
  });

  it("logs NativeBlockDelivered via stop_blocks when the block rides on streamer.stop()", async () => {
    const tableBlock = {
      type: "table",
      rows: [[{ type: "raw_text", text: "cell" }]],
    };
    const invalidArgumentsError = () =>
      Object.assign(new Error("An API error occurred: invalid_arguments"), {
        data: { error: "invalid_arguments" },
      });
    const streamer = {
      // Reject the inline blocks-chunk append so the block stays pending and
      // is delivered on the stop() payload instead.
      append: vi.fn(async (payload: any) => {
        if (payload?.chunks?.some((c: any) => c?.type === "blocks")) {
          throw invalidArgumentsError();
        }
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([streamer]);

    mockAgentStream((async function* () {
      yield {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "draw_table",
        output: { ok: true, __table_block: tableBlock },
      };
      yield { type: "text-delta", text: "Here is the table." };
    })());

    await expect(generateResponse(baseOptions(slackClient))).resolves.toMatchObject({
      raw: "Here is the table.",
      alreadyPosted: true,
    });

    expect(streamer.stop.mock.calls[0][0]).toMatchObject({
      blocks: expect.arrayContaining([tableBlock]),
    });
    expect(logger.info).toHaveBeenCalledWith("NativeBlockDelivered", expect.objectContaining({
      toolCallIds: ["call-1"],
      path: "stop_blocks",
    }));
    expect(logError).not.toHaveBeenCalledWith(expect.objectContaining({
      errorName: "NativeBlockDropped",
    }));
  });

  it("logs NativeBlockDropped when the postMessage fallback for a native block rejects", async () => {
    const tableBlock = {
      type: "table",
      rows: [[{ type: "raw_text", text: "cell" }]],
    };
    const invalidArgumentsError = () =>
      Object.assign(new Error("An API error occurred: invalid_arguments"), {
        data: { error: "invalid_arguments" },
      });
    const streamer = {
      append: vi.fn(async (payload: any) => {
        if (payload?.chunks?.some((c: any) => c?.type === "blocks")) {
          throw invalidArgumentsError();
        }
      }),
      stop: vi.fn()
        .mockRejectedValueOnce(invalidArgumentsError())
        .mockResolvedValueOnce(undefined),
    };
    const slackClient = createSlackClient([streamer]);
    slackClient.chat.postMessage.mockRejectedValue(new Error("channel_not_found"));

    mockAgentStream((async function* () {
      yield {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "draw_table",
        output: { ok: true, __table_block: tableBlock },
      };
      yield { type: "text-delta", text: "Here is the table." };
    })());

    await expect(generateResponse(baseOptions(slackClient))).resolves.toMatchObject({
      raw: "Here is the table.",
      alreadyPosted: true,
    });

    expect(logError).toHaveBeenCalledWith(expect.objectContaining({
      errorName: "NativeBlockDropped",
      errorCode: "native_block_dropped",
      context: expect.objectContaining({
        toolCallIds: ["call-1"],
        path: "post_message_fallback",
        error: "channel_not_found",
      }),
    }));
    // The drop is recorded exactly once — no duplicate turn_end event.
    const droppedCalls = vi.mocked(logError).mock.calls.filter(
      ([params]) => params.errorName === "NativeBlockDropped",
    );
    expect(droppedCalls).toHaveLength(1);
    expect(logger.info).not.toHaveBeenCalledWith(
      "NativeBlockDelivered",
      expect.anything(),
    );
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

  it("splits to a fresh stream when total stream age exceeds 60s across sequential short tools", async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
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
        input: { command: "echo one" },
      };
      yield {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "run_command",
        output: { ok: true, exit_code: 0, stdout: "", stderr: "" },
      };
      // Wall-clock time passes between short tools — no single tool ever
      // stays pending past LONG_TOOL_SPLIT_MS, but the stream still ages.
      await gate.promise;
      yield {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "run_command",
        input: { command: "echo two" },
      };
      yield {
        type: "tool-result",
        toolCallId: "call-2",
        toolName: "run_command",
        output: { ok: true, exit_code: 0, stdout: "", stderr: "" },
      };
      yield { type: "text-delta", text: "Done." };
    })());

    const responsePromise = generateResponse(baseOptions(slackClient));
    await vi.advanceTimersByTimeAsync(0);
    expect(slackClient.chatStream).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(70_000);
    expect(slackClient.chatStream).toHaveBeenCalledTimes(1);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(responsePromise).resolves.toMatchObject({
      raw: "Done.",
      alreadyPosted: true,
    });

    expect(slackClient.chatStream).toHaveBeenCalledTimes(2);
    expect(firstStream.stop).toHaveBeenCalled();
    expect(secondStream.append).toHaveBeenCalledWith({
      chunks: [expect.objectContaining({
        type: "markdown_text",
        text: "Done.",
      })],
    });
    expect(logger.info).toHaveBeenCalledWith(
      "Slack stream exceeded max age; splitting to a fresh stream",
      expect.objectContaining({
        channelId: "C123",
        thresholdMs: 60_000,
      }),
    );
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

  it("logs message_not_in_streaming_state as recovered when postMessage fallback succeeds", async () => {
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

    const mnisLogs = vi.mocked(logError).mock.calls.filter(
      ([entry]) => entry.errorCode === "message_not_in_streaming_state",
    );
    expect(mnisLogs).toHaveLength(1);
    expect(mnisLogs[0]?.[0]).toMatchObject({
      errorName: "MessageNotInStreamingState",
      channelId: "C123",
      context: expect.objectContaining({
        fallback: "postMessage",
        fallbackRecovered: true,
      }),
    });
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

  it("posts an interruption stub when the stream dies with an empty unsent buffer", async () => {
    const stream = {
      append: vi.fn()
        .mockResolvedValueOnce(undefined) // intro text streams fine
        .mockRejectedValueOnce(Object.assign(new Error("message_not_in_streaming_state"), {
          data: { error: "message_not_in_streaming_state" },
        })),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);

    mockAgentStream((async function* () {
      yield { type: "text-delta", text: "Intro." };
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
    })());

    await generateResponse(baseOptions(slackClient));

    // Everything visible already streamed before the freeze and the post-tool
    // tail is empty — the fallback must post a stub, not an empty block list.
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C123",
      thread_ts: "1710000000.000000",
      text: "_Turn interrupted after 1 tool call — rerun?_",
      blocks: expect.arrayContaining([
        expect.objectContaining({
          type: "section",
          text: expect.objectContaining({
            text: "_Turn interrupted after 1 tool call — rerun?_",
          }),
        }),
      ]),
    }));

    const mnisLogs = vi.mocked(logError).mock.calls.filter(
      ([entry]) => entry.errorCode === "message_not_in_streaming_state",
    );
    expect(mnisLogs).toHaveLength(1);
    expect(mnisLogs[0]?.[0]).toMatchObject({
      errorName: "MessageNotInStreamingState",
      context: expect.objectContaining({ fallbackRecovered: true, toolCallCount: 0 }),
    });
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

  it("does not relaunch after run_command_detached suspends the turn", async () => {
    toolStateMocks.detachedSuspendState = { commandId: "abcdef12" };
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
          toolName: "run_command_detached",
          input: { command: "pnpm test" },
        };
        yield {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "run_command_detached",
          output: { id: "abcdef12", pid: 4321, started_at: "2026-05-28T08:00:00.000Z" },
        };
      })()),
    ]);

    await expect(generateResponse(baseOptions(slackClient))).resolves.toMatchObject({
      raw: "Started the detached command. I'll continue when it finishes.",
      alreadyPosted: true,
    });

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logError).mock.calls.some(
      ([entry]) => entry.errorCode === "empty_completion_relaunched",
    )).toBe(false);
    expect(vi.mocked(logError).mock.calls.some(
      ([entry]) => entry.errorCode === "empty_completion_after_tools",
    )).toBe(false);
    expect(stream.append).toHaveBeenCalledWith({
      chunks: [expect.objectContaining({
        type: "markdown_text",
        text: "Started the detached command. I'll continue when it finishes.",
      })],
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

  it("logs a supersede observability row but never relaunches or logs empty completions when superseded", async () => {
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

    // Issue #1121: supersede recovery is preserved, but the event itself is
    // now always visible in error_events with the abort reason.
    const supersededLogs = vi.mocked(logError).mock.calls.filter(
      ([entry]) => entry.errorCode === "superseded_while_streaming",
    );
    expect(supersededLogs).toHaveLength(1);
    expect(supersededLogs[0]?.[0]).toMatchObject({
      errorName: "InvocationSupersededDuringStream",
      channelId: "C123",
      context: expect.objectContaining({
        invocationId: "test-invocation",
        abortReason: "unknown",
        toolCallCount: 1,
      }),
    });

    // newer_message has no native Slack indicator — the markdown note is
    // still appended on the stream close (issue #1355 removes it only for
    // "stopped", where Slack renders its own grey "(stopped)").
    expect(stream.stop).toHaveBeenCalledWith(expect.objectContaining({
      chunks: expect.arrayContaining([
        expect.objectContaining({
          type: "markdown_text",
          text: expect.stringContaining("_[interrupted — new message received]_"),
        }),
      ]),
    }));
  });

  it("skips the postMessage fallback stub when Slack already halted the bubble with its native stopped indicator (issue #1355)", async () => {
    const streamer = {
      // Slack refuses every append once the user pressed Stop.
      append: vi.fn().mockRejectedValue(Object.assign(
        new Error("An API error occurred: stopped_by_user"),
        { data: { ok: false, error: "stopped_by_user" } },
      )),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([streamer]);

    mockAgentStream((async function* () {
      yield { type: "text-delta", text: "Partial answer the user stopped." };
    })());

    const result = await generateResponse(baseOptions(slackClient));

    // The halted bubble carries Slack's native "(stopped)" indicator
    // (ai_context.result_status = "stopped_by_user") — no `_[stopped]_`
    // stub, no "nothing to say" junk, no re-post of the stopped answer.
    expect(slackClient.chat.postMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(streamer.stop.mock.calls)).not.toContain("_[stopped]_");
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      "Stop press rendered natively by Slack — skipping fallback delivery",
      expect.objectContaining({ channelId: "C123" }),
    );
    expect(result.alreadyPosted).toBe(true);
  });

  it("aborts a long-running tool within one toolKeepAlive tick after Stop without duplicating Slack's native stopped indicator (issue #1355)", async () => {
    vi.useFakeTimers();
    try {
      // The lock is already displaced (stop:* sentinel) by the time the
      // keepalive tick re-checks it mid-tool.
      invocationLockMocks.isInvocationCurrent.mockResolvedValue(false);
      invocationLockMocks.getSupersedeReason.mockResolvedValue("stopped");

      const streamer = {
        append: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      const slackClient = createSlackClient([streamer]);

      // A model call that starts a tool and then hangs until the abort
      // signal fires — simulating a 120s sandbox command in flight.
      const streamMock = vi.fn().mockImplementation(async (callOptions: any) =>
        createAgentStreamResult((async function* () {
          yield { type: "text-delta", text: "Kicking off a slow command." };
          yield {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "run_command",
            input: { command: "sleep 120" },
          };
          await new Promise<never>((_, reject) => {
            callOptions.abortSignal.addEventListener("abort", () =>
              reject(Object.assign(new Error("This operation was aborted"), {
                name: "AbortError",
              })),
            );
          });
        })()),
      );
      agentMocks.createInteractiveAgent.mockResolvedValue({
        agent: { stream: streamMock },
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

      const responsePromise = generateResponse({
        ...baseOptions(slackClient),
        invocationId: "inv-live",
      });
      await vi.advanceTimersByTimeAsync(0);
      // No mid-tool check before the keepalive fires.
      expect(invocationLockMocks.isInvocationCurrent).not.toHaveBeenCalled();

      // One 60s toolKeepAlive tick: lock re-checked, abort fired, turn unwinds.
      await vi.advanceTimersByTimeAsync(60_000);

      const result = await responsePromise;
      expect(result.interrupted).toBe(true);
      // raw is the internal record of the turn — the marker stays there…
      expect(result.raw.endsWith("_[stopped]_")).toBe(true);
      expect(invocationLockMocks.isInvocationCurrent).toHaveBeenCalledWith(
        "C123",
        "1710000000.000000",
        "inv-live",
      );

      // The abort resolved to the superseded outcome — never a raw abort
      // tombstone or a generic stream error.
      const supersededLogs = vi.mocked(logError).mock.calls.filter(
        ([entry]) => entry.errorCode === "superseded_while_streaming",
      );
      expect(supersededLogs).toHaveLength(1);
      expect(supersededLogs[0]?.[0]).toMatchObject({
        context: expect.objectContaining({ abortReason: "superseded" }),
      });
      expect(vi.mocked(logError).mock.calls.some(
        ([entry]) => entry.errorCode === "stream_aborted_by_watchdog",
      )).toBe(false);

      // …but NOTHING delivered to Slack carries our own `_[stopped]_`: Slack
      // renders the native grey "(stopped)" indicator on the halted bubble
      // itself, and appending ours would show the marker twice.
      const deliveredPayloads = [
        ...streamer.append.mock.calls,
        ...streamer.stop.mock.calls,
        ...slackClient.chat.postMessage.mock.calls,
      ].flat();
      expect(JSON.stringify(deliveredPayloads)).not.toContain("_[stopped]_");
      // The stream was still closed.
      expect(streamer.stop).toHaveBeenCalled();
    } finally {
      invocationLockMocks.isInvocationCurrent.mockReset();
      invocationLockMocks.isInvocationCurrent.mockResolvedValue(true);
      invocationLockMocks.getSupersedeReason.mockReset();
      invocationLockMocks.getSupersedeReason.mockResolvedValue("newer_message");
    }
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
          stream: (async function* () {
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

    const inactivityLogs = vi.mocked(logError).mock.calls.filter(
      ([entry]) => entry.errorCode === "stream_inactivity_abort",
    );
    expect(inactivityLogs).toHaveLength(1);
    expect(inactivityLogs[0]?.[0]).toMatchObject({
      errorName: "StreamInactivityAbort",
      channelId: "C123",
      context: expect.objectContaining({
        accumulatedTextLength: 0,
        toolCallCount: 0,
      }),
    });

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

describe("generateResponse supersede check at final delivery (issue #1342)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toolStateMocks.detachedSuspendState = undefined;
    invocationLockMocks.isInvocationCurrent.mockResolvedValue(true);
    invocationLockMocks.getSupersedeReason.mockResolvedValue("newer_message");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses the final streamer.stop payload when superseded right before delivery", async () => {
    const stream = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);

    mockAgentStream((async function* () {
      yield { type: "text-delta", text: "Old answer that must not be posted." };
    })());

    // A follow-up message claimed the lock while the final step was streaming,
    // so by the time final delivery runs this invocation is no longer current.
    invocationLockMocks.isInvocationCurrent.mockResolvedValue(false);

    const result = await generateResponse({
      ...baseOptions(slackClient),
      invocationId: "inv-1342-happy",
    });

    // The turn exits via the supersede path, not the happy path.
    expect(result).toMatchObject({ interrupted: true });
    expect(invocationLockMocks.isInvocationCurrent).toHaveBeenCalledWith(
      "C123",
      "1710000000.000000",
      "inv-1342-happy",
    );

    // The final answer payload (blocks + metadata) must NOT be delivered.
    for (const call of stream.stop.mock.calls) {
      expect(call[0]?.blocks).toBeUndefined();
      expect(call[0]?.metadata).toBeUndefined();
    }
    // Instead the stream is finalized with the interruption note only.
    expect(stream.stop).toHaveBeenCalledWith({
      chunks: expect.arrayContaining([
        expect.objectContaining({
          type: "markdown_text",
          text: expect.stringContaining("_[interrupted — new message received]_"),
        }),
      ]),
    });
    expect(slackClient.chat.postMessage).not.toHaveBeenCalled();

    expect(logger.info).toHaveBeenCalledWith(
      "Invocation superseded at final delivery — suppressing answer",
      expect.objectContaining({
        invocationId: "inv-1342-happy",
        channelId: "C123",
        deliveryPath: "stream_stop",
      }),
    );
    const supersedeLogs = vi.mocked(logError).mock.calls.filter(
      ([entry]) => entry.errorCode === "superseded_at_final_delivery",
    );
    expect(supersedeLogs).toHaveLength(1);
    expect(supersedeLogs[0]?.[0]).toMatchObject({
      errorName: "InvocationSupersededAtFinalDelivery",
      channelId: "C123",
      context: expect.objectContaining({
        invocationId: "inv-1342-happy",
        deliveryPath: "stream_stop",
      }),
    });
  });

  it("skips the postMessage fallback when superseded right before delivery", async () => {
    const stream = {
      append: vi.fn().mockRejectedValueOnce(Object.assign(new Error("boom"), {
        data: { error: "some_unexpected_error" },
      })),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);

    mockAgentStream((async function* () {
      yield { type: "text-delta", text: "Fallback answer that must not be posted." };
    })());

    invocationLockMocks.isInvocationCurrent.mockResolvedValue(false);

    const result = await generateResponse({
      ...baseOptions(slackClient),
      invocationId: "inv-1342-fallback",
    });

    expect(result).toMatchObject({ interrupted: true });
    // The fallback text is never posted — no postMessage with real content.
    expect(slackClient.chat.postMessage).not.toHaveBeenCalled();

    const supersedeLogs = vi.mocked(logError).mock.calls.filter(
      ([entry]) => entry.errorCode === "superseded_at_final_delivery",
    );
    expect(supersedeLogs).toHaveLength(1);
    expect(supersedeLogs[0]?.[0]).toMatchObject({
      errorName: "InvocationSupersededAtFinalDelivery",
      channelId: "C123",
      context: expect.objectContaining({
        invocationId: "inv-1342-fallback",
        deliveryPath: "post_message_fallback",
      }),
    });
  });

  it("still delivers the final payload when the invocation is current", async () => {
    const stream = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);

    mockAgentStream((async function* () {
      yield { type: "text-delta", text: "Current answer." };
    })());

    await expect(generateResponse({
      ...baseOptions(slackClient),
      invocationId: "inv-1342-current",
    })).resolves.toMatchObject({
      raw: "Current answer.",
      alreadyPosted: true,
    });

    // Happy-path finalize still carries the feedback block.
    expect(stream.stop).toHaveBeenCalledWith(expect.objectContaining({
      blocks: expect.arrayContaining([
        expect.objectContaining({ type: "context_actions" }),
      ]),
    }));
    const supersedeLogs = vi.mocked(logError).mock.calls.filter(
      ([entry]) => entry.errorCode === "superseded_at_final_delivery",
    );
    expect(supersedeLogs).toHaveLength(0);
  });
});

describe("generateResponse turn markers (stream-death watchdog, issue #1109)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toolStateMocks.detachedSuspendState = undefined;
    invocationLockMocks.isInvocationCurrent.mockResolvedValue(true);
    invocationLockMocks.getSupersedeReason.mockResolvedValue("newer_message");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a turn marker on start and finishes it completed on a clean finish", async () => {
    const stream = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);

    mockAgentStream((async function* () {
      yield { type: "text-delta", text: "All done." };
    })());

    await expect(generateResponse({
      ...baseOptions(slackClient),
      invocationId: "inv-clean-1",
      messageTs: "1710000001.000100",
      context: { userId: "U123", workspaceId: "ws-1" },
    })).resolves.toMatchObject({
      raw: "All done.",
      alreadyPosted: true,
    });

    expect(turnMarkerMocks.startTurnMarker).toHaveBeenCalledTimes(1);
    expect(turnMarkerMocks.startTurnMarker).toHaveBeenCalledWith({
      invocationId: "inv-clean-1",
      channelId: "C123",
      threadTs: "1710000000.000000",
      messageTs: "1710000001.000100",
      userId: "U123",
      workspaceId: "ws-1",
    });
    expect(turnMarkerMocks.finishTurnMarker).toHaveBeenCalledTimes(1);
    expect(turnMarkerMocks.finishTurnMarker).toHaveBeenCalledWith("inv-clean-1", "completed");
  });

  it("writes the marker before the agent stream starts", async () => {
    const stream = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);

    const order: string[] = [];
    turnMarkerMocks.startTurnMarker.mockImplementationOnce(async () => {
      order.push("marker");
    });
    agentMocks.createInteractiveAgent.mockResolvedValue({
      agent: {
        stream: vi.fn().mockImplementation(async () => {
          order.push("stream");
          return createAgentStreamResult((async function* () {
            yield { type: "text-delta", text: "ok" };
          })());
        }),
      },
      tools: {},
      modelId: "test-model",
      getStepModelIds: () => ["test-model"],
    });

    await generateResponse({ ...baseOptions(slackClient), invocationId: "inv-order-1" });

    expect(order[0]).toBe("marker");
    expect(order).toContain("stream");
  });

  it("finishes the marker as failed when the turn throws a handled error", async () => {
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

    await expect(generateResponse({
      ...baseOptions(slackClient),
      invocationId: "inv-fail-1",
    })).rejects.toThrow("tool input failed");

    // The error propagates to the pipeline catch (which posts a graceful
    // message), but the marker MUST already be terminal so the watchdog
    // never treats this handled failure as a hard kill.
    expect(turnMarkerMocks.finishTurnMarker).toHaveBeenCalledTimes(1);
    expect(turnMarkerMocks.finishTurnMarker).toHaveBeenCalledWith("inv-fail-1", "failed");
  });

  it("finishes the marker as completed on an interrupted (superseded) turn", async () => {
    const stream = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([stream]);
    const { InvocationSupersededError } = await import("./prepare-step.js");

    agentMocks.createInteractiveAgent.mockResolvedValue({
      agent: {
        stream: vi.fn().mockResolvedValue(createAgentStreamResult((async function* () {
          throw new InvocationSupersededError("inv-superseded-1");
        })())),
      },
      tools: {},
      modelId: "test-model",
      getStepModelIds: () => ["test-model"],
    });

    await expect(generateResponse({
      ...baseOptions(slackClient),
      invocationId: "inv-superseded-1",
    })).resolves.toMatchObject({ interrupted: true });

    expect(turnMarkerMocks.finishTurnMarker).toHaveBeenCalledTimes(1);
    expect(turnMarkerMocks.finishTurnMarker).toHaveBeenCalledWith("inv-superseded-1", "completed");
  });

  it("does not track markers for headless turns", async () => {
    const slackClient = createSlackClient([]);

    mockAgentStream((async function* () {
      yield { type: "text-delta", text: "Headless output." };
    })());

    await expect(generateResponse({
      ...baseOptions(slackClient),
      invocationId: "inv-headless-1",
      isHeadless: true,
    })).resolves.toMatchObject({
      raw: "Headless output.",
      alreadyPosted: true,
    });

    expect(turnMarkerMocks.startTurnMarker).not.toHaveBeenCalled();
    expect(turnMarkerMocks.finishTurnMarker).not.toHaveBeenCalled();
  });
});

describe("generateResponse duplicate final message suppression (issue #1343)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toolStateMocks.detachedSuspendState = undefined;
    invocationLockMocks.isInvocationCurrent.mockResolvedValue(true);
    invocationLockMocks.getSupersedeReason.mockResolvedValue("newer_message");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const postedMessage =
    "Numbers are internally consistent: 26 agencies with ranking data, 14 with a paid " +
    "subscription, and the ranking rule only counts agencies with 3+ listings.";
  const duplicateFinalText =
    "*Posted in-thread.* Numbers are internally consistent — 26 agencies with ranking data, " +
    "14 with a paid subscription; the ranking rule only counts agencies with 3+ listings.";

  function sameThreadPostTurn(finalText: string) {
    return (async function* () {
      yield {
        type: "tool-call",
        toolCallId: "call-post-1",
        toolName: "send_thread_reply",
        input: {
          channel: "C123",
          thread_ts: "1710000000.000000",
          message: postedMessage,
        },
      };
      yield {
        type: "tool-result",
        toolCallId: "call-post-1",
        toolName: "send_thread_reply",
        output: { ok: true, message: "Reply sent in thread in #bugs", timestamp: "1710000009.000000" },
      };
      yield { type: "text-delta", text: finalText };
    })();
  }

  it("suppresses a final message that duplicates a send_thread_reply into the same thread", async () => {
    const streamer = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([streamer]);

    mockAgentStream(sameThreadPostTurn(duplicateFinalText));

    const result = await generateResponse(baseOptions(slackClient));
    expect(result.alreadyPosted).toBe(true);
    // The raw trace still contains what the model said…
    expect(result.raw).toBe(duplicateFinalText);

    // …but the duplicate never reached the Slack stream, and nothing was
    // posted as a fallback either.
    const appendedPayloads = streamer.append.mock.calls
      .map(([payload]) => JSON.stringify(payload))
      .join("\n");
    expect(appendedPayloads).not.toContain("Posted in-thread");
    expect(slackClient.chat.postMessage).not.toHaveBeenCalled();

    expect(logError).toHaveBeenCalledWith(expect.objectContaining({
      errorName: "DuplicateFinalMessageSuppressed",
      errorCode: "duplicate_final_message_suppressed",
      channelId: "C123",
    }));
  });

  it("still delivers a final message that does NOT duplicate the tool post", async () => {
    const streamer = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([streamer]);

    const distinctFinalText =
      "I also opened issue #1344 to track the subscription mismatch and pinged the data " +
      "team about backfilling the missing rows tomorrow morning.";
    mockAgentStream(sameThreadPostTurn(distinctFinalText));

    const result = await generateResponse(baseOptions(slackClient));
    expect(result.raw).toBe(distinctFinalText);

    const appendedPayloads = streamer.append.mock.calls
      .map(([payload]) => JSON.stringify(payload))
      .join("\n");
    expect(appendedPayloads).toContain("opened issue #1344");
    expect(streamer.stop).toHaveBeenCalledTimes(1);

    const suppressionLogs = vi.mocked(logError).mock.calls.filter(
      ([entry]) => entry.errorCode === "duplicate_final_message_suppressed",
    );
    expect(suppressionLogs).toHaveLength(0);
  });

  it("streams text immediately when the tool post targeted a different thread", async () => {
    const streamer = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const slackClient = createSlackClient([streamer]);

    mockAgentStream((async function* () {
      yield {
        type: "tool-call",
        toolCallId: "call-post-2",
        toolName: "send_thread_reply",
        input: { channel: "C0OTHER99", thread_ts: "1700000000.000042", message: "elsewhere" },
      };
      yield {
        type: "tool-result",
        toolCallId: "call-post-2",
        toolName: "send_thread_reply",
        output: { ok: true, message: "Reply sent in thread in #other", timestamp: "1700000001.000000" },
      };
      yield { type: "text-delta", text: "Cross-posted the fix to #other as requested." };
    })());

    await expect(generateResponse(baseOptions(slackClient))).resolves.toMatchObject({
      raw: "Cross-posted the fix to #other as requested.",
      alreadyPosted: true,
    });

    expect(streamer.append).toHaveBeenCalledWith({
      chunks: [expect.objectContaining({
        type: "markdown_text",
        text: "Cross-posted the fix to #other as requested.",
      })],
    });
  });

  it("suppresses the duplicate on the headless postMessage fallback path too", async () => {
    const slackClient = createSlackClient([]);

    mockAgentStream(sameThreadPostTurn(duplicateFinalText));

    const result = await generateResponse({
      ...baseOptions(slackClient),
      isHeadless: true,
    });
    expect(result.raw).toBe(duplicateFinalText);

    // The only undelivered content was the duplicate — no fallback post.
    expect(slackClient.chat.postMessage).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "duplicate_final_message_suppressed",
    }));
  });
});
