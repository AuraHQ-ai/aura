/**
 * Workflow-loop turn-deadline behaviour (issue #1320).
 *
 * Under vitest the `"use workflow"` / `"use step"` directives are inert, so
 * `slackRespondWorkflow` runs as a plain async function while every
 * dynamically-imported dependency is mocked. A virtual `Date.now()` clock is
 * advanced by the mocked model call, letting the tests drive the loop across
 * the soft and hard wall-clock deadlines deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Virtual clock ─────────────────────────────────────────────────────────────

const clock = vi.hoisted(() => ({ now: 1_000_000_000_000 }));

// ── Model-call scripting ──────────────────────────────────────────────────────

type StepScript = { finishReason: string; text?: string; advanceMs?: number };

const aiMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  scripts: [] as StepScript[],
}));

vi.mock("ai", () => ({
  streamText: aiMocks.streamText,
  isStepCount: (n: number) => n,
  pruneMessages: ({ messages }: { messages: unknown[] }) => messages,
}));

// ── Slack / gateway / pipeline mocks ─────────────────────────────────────────

const slackMocks = vi.hoisted(() => ({
  apiCall: vi.fn(async () => ({ ts: "111.222" })),
  postMessage: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@slack/web-api", () => ({
  WebClient: class {
    apiCall = slackMocks.apiCall;
    chat = { postMessage: slackMocks.postMessage };
  },
}));

vi.mock("@ai-sdk/gateway", () => ({
  gateway: vi.fn(() => ({ modelId: "gw-model" })),
}));

const libAiMocks = vi.hoisted(() => ({
  buildCachedSystemMessages: vi.fn((..._args: unknown[]) => [
    { role: "system", content: "sys" },
  ]),
}));

vi.mock("../src/lib/ai.js", () => ({
  withAnthropicFallback: (model: unknown) => model,
  getEscalationModel: vi.fn(async () => ({ modelId: "esc", model: {} })),
  buildCachedSystemMessages: libAiMocks.buildCachedSystemMessages,
}));

const toolMocks = vi.hoisted(() => ({
  createSlackTools: vi.fn(async () => ({ some_tool: { description: "t" } })),
}));

vi.mock("../src/tools/slack.js", () => ({
  createSlackTools: toolMocks.createSlackTools,
}));

vi.mock("../src/tools/deferred.js", () => ({
  getDeferredToolManifest: () => [],
}));

vi.mock("../src/personality/system-prompt.js", () => ({
  appendDeferredToolsBlock: (prompt: string | undefined) => prompt,
}));

// Keep the REAL deadline message constants so the assertions cover the exact
// strings the production workflow injects; only stub the catalog lookup.
vi.mock("../src/pipeline/prepare-step.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pipeline/prepare-step.js")>();
  return {
    ...actual,
    getProviderThinkingOptions: vi.fn(async () => ({})),
  };
});

vi.mock("../src/lib/model-catalog.js", () => ({
  getModelCapabilities: vi.fn(async () => ({
    found: false,
    supportsThinking: false,
    tags: [],
    capabilities: null,
  })),
}));

const lockMocks = vi.hoisted(() => ({
  isInvocationCurrent: vi.fn(async () => true),
  getSupersedeReason: vi.fn(async () => "newer_message"),
}));

vi.mock("../src/lib/invocation-lock.js", () => ({
  isInvocationCurrent: lockMocks.isInvocationCurrent,
  getSupersedeReason: lockMocks.getSupersedeReason,
  interruptionNote: (reason: string) =>
    reason === "stopped" ? "_[stopped]_" : "_[interrupted — new message received]_",
}));

vi.mock("../src/lib/tool.js", () => ({
  executionContext: { run: (_ctx: unknown, fn: () => unknown) => fn() },
  getSlackMeta: () => undefined,
}));

vi.mock("../src/lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const errorLoggerMocks = vi.hoisted(() => ({
  logError: vi.fn(),
}));

vi.mock("../src/lib/error-logger.js", () => ({
  logError: errorLoggerMocks.logError,
}));

const turnDeadlineMocks = vi.hoisted(() => ({
  resolveTurnDeadlines: vi.fn(),
  spawnTurnContinuationJob: vi.fn(async () => true),
}));

vi.mock("../src/pipeline/turn-deadline.js", () => ({
  resolveTurnDeadlines: turnDeadlineMocks.resolveTurnDeadlines,
  spawnTurnContinuationJob: turnDeadlineMocks.spawnTurnContinuationJob,
}));

const backgroundMocks = vi.hoisted(() => ({
  runBackgroundTasks: vi.fn(async () => {}),
}));

vi.mock("../src/pipeline/index.js", () => ({
  runBackgroundTasks: backgroundMocks.runBackgroundTasks,
}));

vi.mock("../src/db/client.js", () => ({
  db: {},
}));

import {
  slackRespondWorkflow,
  evaluateTurnDeadlines,
  type SlackRespondWorkflowInput,
} from "./slack-respond.js";
import {
  TURN_SOFT_DEADLINE_MESSAGE,
  TURN_HARD_DEADLINE_MESSAGE_WITH_CONTINUATION,
  TURN_HARD_DEADLINE_MESSAGE_WITHOUT_CONTINUATION,
} from "../src/pipeline/prepare-step.js";

function buildInput(): SlackRespondWorkflowInput {
  return {
    stablePrefix: "PREFIX",
    environmentContext: "ENV",
    conversationContext: "CONVO",
    userMessage: "hello",
    channelId: "C0123456",
    threadTs: "1755500000.000100",
    userId: "U0999",
    invocationId: "inv-1",
    modelId: "test-model",
    background: {
      context: {} as SlackRespondWorkflowInput["background"]["context"],
      event: {},
      displayName: "Tester",
      threadMessageCount: 1,
      recentThreadMessages: [],
      threadMessagesElided: false,
      systemPrompt: "sys",
    },
  };
}

/** dynamicContext (4th positional arg) of the Nth buildCachedSystemMessages call. */
function dynamicContextOfCall(index: number): string | undefined {
  return libAiMocks.buildCachedSystemMessages.mock.calls[index]?.[3] as
    | string
    | undefined;
}

describe("evaluateTurnDeadlines", () => {
  it("flags nothing under the soft deadline", () => {
    expect(
      evaluateTurnDeadlines(99_999, { softDeadlineMs: 100_000, hardDeadlineMs: 200_000 }),
    ).toEqual({ softDeadlineReached: false, hardDeadlineReached: false });
  });

  it("flags the soft deadline at and past the boundary", () => {
    expect(
      evaluateTurnDeadlines(100_000, { softDeadlineMs: 100_000, hardDeadlineMs: 200_000 }),
    ).toEqual({ softDeadlineReached: true, hardDeadlineReached: false });
  });

  it("flags both once the hard deadline is reached", () => {
    expect(
      evaluateTurnDeadlines(200_000, { softDeadlineMs: 100_000, hardDeadlineMs: 200_000 }),
    ).toEqual({ softDeadlineReached: true, hardDeadlineReached: true });
  });
});

describe("slackRespondWorkflow turn wall-clock budget (issue #1320)", () => {
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clock.now = 1_000_000_000_000;
    dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    aiMocks.scripts = [];
    aiMocks.streamText.mockImplementation(() => {
      const script = aiMocks.scripts.shift() ?? { finishReason: "stop", text: "fallback" };
      clock.now += script.advanceMs ?? 0;
      return {
        stream: (async function* () {
          if (script.text) {
            yield { type: "text-delta", text: script.text };
          }
        })(),
        response: Promise.resolve({
          messages: [{ role: "assistant", content: script.text ?? "" }],
          modelId: "test-model",
        }),
        finishReason: Promise.resolve(script.finishReason),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
      };
    });
    turnDeadlineMocks.spawnTurnContinuationJob.mockResolvedValue(true);
    turnDeadlineMocks.resolveTurnDeadlines.mockReturnValue({
      softDeadlineMs: 100_000,
      hardDeadlineMs: 200_000,
    });
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  it("records the turn clock once via resolveTurnDeadlines('interactive')", async () => {
    aiMocks.scripts = [{ finishReason: "stop", text: "done" }];

    await slackRespondWorkflow(buildInput());

    expect(turnDeadlineMocks.resolveTurnDeadlines).toHaveBeenCalledTimes(1);
    expect(turnDeadlineMocks.resolveTurnDeadlines).toHaveBeenCalledWith("interactive");
  });

  it("runs normally with full tools and no nudges under the soft deadline", async () => {
    aiMocks.scripts = [
      { finishReason: "tool-calls", advanceMs: 60_000 },
      { finishReason: "stop", text: "done", advanceMs: 10_000 },
    ];

    const result = await slackRespondWorkflow(buildInput());

    expect(result).toEqual({ interrupted: false, text: "done" });
    expect(toolMocks.createSlackTools).toHaveBeenCalledTimes(2);
    expect(dynamicContextOfCall(0)).toBeUndefined();
    expect(dynamicContextOfCall(1)).toBeUndefined();
    expect(turnDeadlineMocks.spawnTurnContinuationJob).not.toHaveBeenCalled();
    expect(errorLoggerMocks.logError).not.toHaveBeenCalled();
  });

  it("injects the soft-deadline wrap-up nudge once elapsed crosses the soft budget", async () => {
    aiMocks.scripts = [
      { finishReason: "tool-calls", advanceMs: 60_000 },
      { finishReason: "tool-calls", advanceMs: 60_000 },
      // elapsed is now 120s ≥ 100s soft deadline → this step gets the nudge
      { finishReason: "stop", text: "done", advanceMs: 10_000 },
    ];

    const result = await slackRespondWorkflow(buildInput());

    expect(result).toEqual({ interrupted: false, text: "done" });
    expect(dynamicContextOfCall(0)).toBeUndefined();
    expect(dynamicContextOfCall(1)).toBeUndefined();
    const nudged = dynamicContextOfCall(2);
    expect(nudged).toContain(
      TURN_SOFT_DEADLINE_MESSAGE.replace("{elapsedSec}", "120"),
    );
    // The soft deadline never withdraws tools.
    expect(toolMocks.createSlackTools).toHaveBeenCalledTimes(3);
    expect(turnDeadlineMocks.spawnTurnContinuationJob).not.toHaveBeenCalled();
    expect(errorLoggerMocks.logError).not.toHaveBeenCalled();
  });

  it("withdraws tools, logs turn_hard_deadline and spawns the continuation at the hard deadline", async () => {
    aiMocks.scripts = [
      { finishReason: "tool-calls", advanceMs: 80_000 }, // elapsed 80s
      { finishReason: "tool-calls", advanceMs: 80_000 }, // elapsed 160s (soft nudge next)
      { finishReason: "tool-calls", advanceMs: 80_000 }, // elapsed 240s ≥ 200s hard
      { finishReason: "stop", text: "final summary" }, // hard-deadline step, no tools
    ];

    const result = await slackRespondWorkflow(buildInput());

    expect(result).toEqual({ interrupted: false, text: "final summary" });

    // Steps 0-2 ran with tools; step 3 (elapsed 240s ≥ 200s hard) with none.
    expect(toolMocks.createSlackTools).toHaveBeenCalledTimes(3);
    const lastStreamTextArgs = aiMocks.streamText.mock.calls[3]?.[0];
    expect(lastStreamTextArgs?.tools).toEqual({});

    expect(errorLoggerMocks.logError).toHaveBeenCalledTimes(1);
    expect(errorLoggerMocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorName: "TurnHardDeadline",
        errorCode: "turn_hard_deadline",
        channelId: "C0123456",
        userId: "U0999",
        context: expect.objectContaining({
          elapsedMs: 240_000,
          step: 3,
          path: "interactive",
        }),
      }),
    );

    expect(turnDeadlineMocks.spawnTurnContinuationJob).toHaveBeenCalledTimes(1);
    expect(turnDeadlineMocks.spawnTurnContinuationJob).toHaveBeenCalledWith({
      channelId: "C0123456",
      threadTs: "1755500000.000100",
      userId: "U0999",
      invocationId: "inv-1",
      elapsedMs: 240_000,
      step: 3,
    });

    expect(dynamicContextOfCall(3)).toContain(
      TURN_HARD_DEADLINE_MESSAGE_WITH_CONTINUATION,
    );

    // The turn still finalizes normally (delivery + persistence parity).
    expect(backgroundMocks.runBackgroundTasks).toHaveBeenCalledTimes(1);
  });

  it("breaks the loop after the hard-deadline step even if the model tries to continue", async () => {
    turnDeadlineMocks.resolveTurnDeadlines.mockReturnValue({
      softDeadlineMs: 50_000,
      hardDeadlineMs: 100_000,
    });
    aiMocks.scripts = [
      { finishReason: "tool-calls", advanceMs: 120_000 },
      // hard-deadline step: model "tries" to keep tool-calling
      { finishReason: "tool-calls", text: "wrapping up", advanceMs: 10_000 },
      // must never run:
      { finishReason: "stop", text: "should not appear" },
    ];

    const result = await slackRespondWorkflow(buildInput());

    expect(result.text).toBe("wrapping up");
    expect(aiMocks.streamText).toHaveBeenCalledTimes(2);
  });

  it("uses the without-continuation hand-off when the spawn fails", async () => {
    turnDeadlineMocks.spawnTurnContinuationJob.mockResolvedValue(false);
    turnDeadlineMocks.resolveTurnDeadlines.mockReturnValue({
      softDeadlineMs: 50_000,
      hardDeadlineMs: 100_000,
    });
    aiMocks.scripts = [
      { finishReason: "tool-calls", advanceMs: 120_000 },
      { finishReason: "stop", text: "final summary" },
    ];

    const result = await slackRespondWorkflow(buildInput());

    expect(result).toEqual({ interrupted: false, text: "final summary" });
    expect(dynamicContextOfCall(1)).toContain(
      TURN_HARD_DEADLINE_MESSAGE_WITHOUT_CONTINUATION,
    );
    expect(dynamicContextOfCall(1)).not.toContain(
      TURN_HARD_DEADLINE_MESSAGE_WITH_CONTINUATION,
    );
  });
});

describe("mid-tool cancellation via Stop (issue #1355)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    turnDeadlineMocks.resolveTurnDeadlines.mockReturnValue({
      softDeadlineMs: 600_000,
      hardDeadlineMs: 1_200_000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    // mockResolvedValue* persists across clearAllMocks — restore the defaults
    // so later tests see a live lock again.
    lockMocks.isInvocationCurrent.mockReset();
    lockMocks.isInvocationCurrent.mockResolvedValue(true);
    lockMocks.getSupersedeReason.mockReset();
    lockMocks.getSupersedeReason.mockResolvedValue("newer_message");
  });

  /**
   * Drive one mid-tool supersede: step-boundary lock check passes, a tool
   * starts and hangs (simulating a 120s sandbox command), the keepalive tick
   * discovers the displaced lock and aborts. Returns the workflow result and
   * the markdown texts appended to the Slack stream.
   */
  async function runMidToolSupersede(reason: "stopped" | "newer_message") {
    lockMocks.isInvocationCurrent
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    lockMocks.getSupersedeReason.mockResolvedValue(reason);

    aiMocks.streamText.mockImplementation((opts: any) => ({
      stream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "some_tool",
          input: { command: "sleep 120" },
        };
        await new Promise<never>((_, reject) => {
          opts.abortSignal.addEventListener("abort", () =>
            reject(
              Object.assign(new Error("This operation was aborted"), {
                name: "AbortError",
              }),
            ),
          );
        });
      })(),
      response: Promise.resolve({ messages: [], modelId: "test-model" }),
      finishReason: Promise.resolve("tool-calls"),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    }));

    const run = slackRespondWorkflow(buildInput());
    // Let the step start, the tool-call land, and the stream bubble open.
    await vi.advanceTimersByTimeAsync(0);
    expect(lockMocks.isInvocationCurrent).toHaveBeenCalledTimes(1);

    // One 20s keepalive tick: lock re-checked, abort fired, turn unwinds.
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await run;

    const appendedMarkdownTexts = (slackMocks.apiCall.mock.calls as any[][])
      .filter(([method]) => method === "chat.appendStream")
      .flatMap(([, params]) => params?.chunks ?? [])
      .filter((chunk: any) => chunk.type === "markdown_text")
      .map((chunk: any) => chunk.text as string);
    return { result, appendedMarkdownTexts };
  }

  it("aborts within one keepalive tick on Stop WITHOUT duplicating Slack's native stopped indicator", async () => {
    const { result, appendedMarkdownTexts } = await runMidToolSupersede("stopped");

    expect(result).toEqual({ interrupted: true, text: "" });
    expect(lockMocks.isInvocationCurrent).toHaveBeenCalledTimes(2);

    // Slack renders its own grey "(stopped)" on the halted bubble
    // (ai_context.result_status = "stopped_by_user") — we must NOT append
    // our own marker on top of it.
    expect(appendedMarkdownTexts.some((t) => t.includes("_[stopped]_"))).toBe(false);
    // The stream is still closed cleanly.
    expect(slackMocks.apiCall).toHaveBeenCalledWith(
      "chat.stopStream",
      expect.objectContaining({ ts: "111.222" }),
    );

    // Never surfaced as a step failure / model error.
    expect(errorLoggerMocks.logError).not.toHaveBeenCalled();
    // Not a completed turn: no background persistence.
    expect(backgroundMocks.runBackgroundTasks).not.toHaveBeenCalled();
  });

  it("still appends the interrupted note when superseded by a newer message (no native indicator)", async () => {
    const { result, appendedMarkdownTexts } = await runMidToolSupersede("newer_message");

    expect(result).toEqual({ interrupted: true, text: "" });
    expect(
      appendedMarkdownTexts.some((t) =>
        t.includes("_[interrupted — new message received]_"),
      ),
    ).toBe(true);
    expect(appendedMarkdownTexts.some((t) => t.includes("_[stopped]_"))).toBe(false);
  });
});
