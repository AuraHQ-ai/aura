import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCapabilities } from "@aura/db/schema";

const catalogMocks = vi.hoisted(() => ({
  getModelCapabilities: vi.fn(),
}));

vi.mock("../lib/model-catalog.js", () => ({
  getModelCapabilities: catalogMocks.getModelCapabilities,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const invocationLockMocks = vi.hoisted(() => ({
  isInvocationCurrent: vi.fn(),
}));

vi.mock("../lib/invocation-lock.js", () => ({
  isInvocationCurrent: invocationLockMocks.isInvocationCurrent,
}));

const errorLoggerMocks = vi.hoisted(() => ({
  logError: vi.fn(),
}));

vi.mock("../lib/error-logger.js", () => ({
  logError: errorLoggerMocks.logError,
}));

const turnDeadlineMocks = vi.hoisted(() => ({
  spawnTurnContinuationJob: vi.fn(),
}));

vi.mock("./turn-deadline.js", () => ({
  spawnTurnContinuationJob: turnDeadlineMocks.spawnTurnContinuationJob,
}));

// prepare-step imports tools/deferred.js (for hasAnthropicServerSideTools),
// which imports the db client — mock it so tests don't require DATABASE_URL.
vi.mock("../db/client.js", () => ({ db: {} }));

import {
  createPrepareStep,
  getProviderThinkingOptions,
  resolveProviderThinkingOptions,
} from "./prepare-step.js";
import type { ModelMessage } from "ai";

function catalogRow(capabilities: ModelCapabilities | null, supportsThinking = true) {
  return {
    found: true,
    supportsThinking,
    tags: supportsThinking ? ["reasoning"] : [],
    capabilities,
  };
}

describe("getProviderThinkingOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves Anthropic adaptive thinking", async () => {
    catalogMocks.getModelCapabilities.mockResolvedValue(
      catalogRow({ provider: "anthropic", thinkingMode: "adaptive" }),
    );

    await expect(getProviderThinkingOptions("anthropic/claude-opus-4.7", 8000))
      .resolves.toEqual({
        anthropic: { thinking: { type: "adaptive" } },
      });
  });

  it("resolves Anthropic enabled thinking with the requested budget", async () => {
    catalogMocks.getModelCapabilities.mockResolvedValue(
      catalogRow({ provider: "anthropic", thinkingMode: "enabled" }),
    );

    await expect(getProviderThinkingOptions("anthropic/claude-opus-4.6", 12000))
      .resolves.toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } },
      });
  });

  it("resolves OpenAI reasoning effort", async () => {
    catalogMocks.getModelCapabilities.mockResolvedValue(
      catalogRow({ provider: "openai", reasoningEffort: "medium" }),
    );

    await expect(getProviderThinkingOptions("openai/gpt-5.1", 8000))
      .resolves.toEqual({
        openai: { reasoningEffort: "medium" },
      });
  });

  it("resolves Google dynamic thinking budget to provider dynamic mode", async () => {
    catalogMocks.getModelCapabilities.mockResolvedValue(
      catalogRow({ provider: "google", thinkingBudget: "dynamic" }),
    );

    await expect(getProviderThinkingOptions("google/gemini-2.5-pro", 8000))
      .resolves.toEqual({
        google: { thinkingConfig: { thinkingBudget: -1 } },
      });
  });

  it("resolves xAI reasoning effort", async () => {
    catalogMocks.getModelCapabilities.mockResolvedValue(
      catalogRow({ provider: "xai", reasoningEffort: "low" }),
    );

    await expect(getProviderThinkingOptions("xai/grok-4-fast-reasoning", 8000))
      .resolves.toEqual({
        xai: { reasoningEffort: "low" },
      });
  });

  it("falls back to enabled thinking for reasoning Anthropic models with null capabilities", () => {
    expect(
      resolveProviderThinkingOptions(
        "anthropic/claude-opus-4.9",
        null,
        8000,
        { found: true, supportsThinking: true },
      ),
    ).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } },
    });
  });

  it("returns no override for non-reasoning null capabilities and unknown providers", () => {
    expect(
      resolveProviderThinkingOptions(
        "anthropic/claude-haiku-4.5",
        null,
        8000,
        { found: true, supportsThinking: false },
      ),
    ).toEqual({});

    expect(
      resolveProviderThinkingOptions(
        "deepseek/deepseek-v3.2-thinking",
        null,
        8000,
        { found: true, supportsThinking: true },
      ),
    ).toEqual({});
  });
});

describe("createPrepareStep turn wall-clock deadlines (issue #1318)", () => {
  const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

  function buildStepArgs(stepNumber: number) {
    return { stepNumber, steps: [], messages };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    turnDeadlineMocks.spawnTurnContinuationJob.mockResolvedValue(true);
    invocationLockMocks.isInvocationCurrent.mockResolvedValue(true);
  });

  it("does nothing when no turn deadlines are configured", async () => {
    const prepareStep = createPrepareStep({ stablePrefix: "PREFIX" });

    const result = await prepareStep(buildStepArgs(5));

    expect(result?.instructions).toBeUndefined();
    expect(result?.activeTools).toBeUndefined();
    expect(result?.toolChoice).toBeUndefined();
    expect(errorLoggerMocks.logError).not.toHaveBeenCalled();
    expect(turnDeadlineMocks.spawnTurnContinuationJob).not.toHaveBeenCalled();
  });

  it("injects the soft-deadline wrap-up nudge exactly once", async () => {
    const prepareStep = createPrepareStep({
      stablePrefix: "PREFIX",
      channelId: "C0123456",
      userId: "U0999",
      turnDeadlines: { softDeadlineMs: 0, hardDeadlineMs: 999_999_999 },
    });

    const first = await prepareStep(buildStepArgs(3));
    expect(first?.instructions).toContain("wall-clock limit");
    expect(first?.instructions).toContain("PREFIX");
    // Soft deadline never withdraws tools.
    expect(first?.activeTools).toBeUndefined();
    expect(first?.toolChoice).toBeUndefined();

    const second = await prepareStep(buildStepArgs(4));
    expect(second?.instructions).toBeUndefined();

    const third = await prepareStep(buildStepArgs(5));
    expect(third?.instructions).toBeUndefined();

    const softCalls = errorLoggerMocks.logError.mock.calls.filter(
      ([params]) => params.errorCode === "turn_soft_deadline",
    );
    expect(softCalls).toHaveLength(1);
    expect(softCalls[0][0]).toMatchObject({
      errorName: "TurnSoftDeadline",
      channelId: "C0123456",
      userId: "U0999",
      context: expect.objectContaining({
        elapsedMs: expect.any(Number),
        step: 3,
      }),
    });
    expect(turnDeadlineMocks.spawnTurnContinuationJob).not.toHaveBeenCalled();
  });

  it("withdraws all tools for every step past the hard deadline", async () => {
    const prepareStep = createPrepareStep({
      stablePrefix: "PREFIX",
      turnDeadlines: { softDeadlineMs: 0, hardDeadlineMs: 0 },
    });

    const first = await prepareStep(buildStepArgs(10));
    expect(first?.activeTools).toEqual([]);
    expect(first?.toolChoice).toBe("none");
    expect(first?.instructions).toContain("wall-clock budget is exhausted");
    expect(first?.instructions).toContain("continuation job has already been scheduled");

    // Tools stay withdrawn on subsequent steps too.
    const second = await prepareStep(buildStepArgs(11));
    expect(second?.activeTools).toEqual([]);
    expect(second?.toolChoice).toBe("none");
  });

  it("spawns a continuation job with thread metadata and logs telemetry once", async () => {
    const prepareStep = createPrepareStep({
      stablePrefix: "PREFIX",
      channelId: "C0123456",
      threadTs: "1755500000.000100",
      userId: "U0999",
      invocationId: "inv-1",
      turnDeadlines: { softDeadlineMs: 0, hardDeadlineMs: 0 },
    });

    await prepareStep(buildStepArgs(10));
    await prepareStep(buildStepArgs(11));

    expect(turnDeadlineMocks.spawnTurnContinuationJob).toHaveBeenCalledTimes(1);
    expect(turnDeadlineMocks.spawnTurnContinuationJob).toHaveBeenCalledWith({
      channelId: "C0123456",
      threadTs: "1755500000.000100",
      userId: "U0999",
      invocationId: "inv-1",
      elapsedMs: expect.any(Number),
      step: 10,
      depth: 1,
    });

    const hardCalls = errorLoggerMocks.logError.mock.calls.filter(
      ([params]) => params.errorCode === "turn_hard_deadline",
    );
    expect(hardCalls).toHaveLength(1);
    expect(hardCalls[0][0]).toMatchObject({
      errorName: "TurnHardDeadline",
      channelId: "C0123456",
      userId: "U0999",
      context: expect.objectContaining({
        elapsedMs: expect.any(Number),
        step: 10,
      }),
    });

    // The soft nudge is skipped once the hard deadline is active.
    const softCalls = errorLoggerMocks.logError.mock.calls.filter(
      ([params]) => params.errorCode === "turn_soft_deadline",
    );
    expect(softCalls).toHaveLength(0);
  });

  it("spawns the next continuation at the current depth + 1 (issue #1320)", async () => {
    const prepareStep = createPrepareStep({
      stablePrefix: "PREFIX",
      channelId: "C0123456",
      threadTs: "1755500000.000100",
      turnDeadlines: { softDeadlineMs: 0, hardDeadlineMs: 0 },
      continuationDepth: 2,
    });

    await prepareStep(buildStepArgs(10));

    expect(turnDeadlineMocks.spawnTurnContinuationJob).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 3 }),
    );
  });

  it("tells the model to hand off manually when the continuation spawn fails", async () => {
    turnDeadlineMocks.spawnTurnContinuationJob.mockResolvedValue(false);
    const prepareStep = createPrepareStep({
      stablePrefix: "PREFIX",
      turnDeadlines: { softDeadlineMs: 0, hardDeadlineMs: 0 },
    });

    const result = await prepareStep(buildStepArgs(10));
    expect(result?.activeTools).toEqual([]);
    expect(result?.instructions).toContain("they can ask you to resume");
    expect(result?.instructions).not.toContain("continuation job has already been scheduled");
  });
});

describe("createPrepareStep anthropic gateway pin for server-side tools (issue #1357)", () => {
  const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

  const SERVER_TOOL = {
    type: "provider",
    id: "anthropic.tool_search_bm25_20251119",
    args: {},
  };

  function buildStepArgs(stepNumber: number) {
    return { stepNumber, steps: [], messages };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    invocationLockMocks.isInvocationCurrent.mockResolvedValue(true);
    catalogMocks.getModelCapabilities.mockResolvedValue(
      catalogRow({ provider: "anthropic", thinkingMode: "enabled" }),
    );
  });

  it("pins the gateway to the first-party anthropic upstream when server tools are present, preserving thinking options", async () => {
    const prepareStep = createPrepareStep({
      stablePrefix: "PREFIX",
      modelId: "anthropic/claude-opus-4.5",
      thinkingBudget: 8000,
      tools: {
        toolSearch: SERVER_TOOL,
        check_calendar: { description: "regular tool" },
      },
    });

    const result = await prepareStep(buildStepArgs(1));

    expect((result?.providerOptions as any)?.gateway?.only).toEqual(["anthropic"]);
    // The existing anthropic thinking options must not be clobbered.
    expect((result?.providerOptions as any)?.anthropic?.thinking).toEqual({
      type: "enabled",
      budgetTokens: 8000,
    });
  });

  it("does not pin the gateway when no server tools are present", async () => {
    const prepareStep = createPrepareStep({
      stablePrefix: "PREFIX",
      modelId: "anthropic/claude-opus-4.5",
      thinkingBudget: 8000,
      tools: {
        check_calendar: { description: "regular tool" },
      },
    });

    const result = await prepareStep(buildStepArgs(1));

    expect((result?.providerOptions as any)?.gateway).toBeUndefined();
    expect((result?.providerOptions as any)?.anthropic?.thinking).toEqual({
      type: "enabled",
      budgetTokens: 8000,
    });
  });

  it("does not pin the gateway when tools are omitted entirely", async () => {
    const prepareStep = createPrepareStep({
      stablePrefix: "PREFIX",
      modelId: "anthropic/claude-opus-4.5",
      thinkingBudget: 8000,
    });

    const result = await prepareStep(buildStepArgs(1));

    expect((result?.providerOptions as any)?.gateway).toBeUndefined();
  });

  it("pins the gateway even when no thinking options resolve", async () => {
    catalogMocks.getModelCapabilities.mockResolvedValue(
      catalogRow({ provider: "anthropic", thinkingMode: "none" }, false),
    );
    const prepareStep = createPrepareStep({
      stablePrefix: "PREFIX",
      modelId: "anthropic/claude-opus-4.5",
      thinkingBudget: 8000,
      tools: { toolSearch: SERVER_TOOL },
    });

    const result = await prepareStep(buildStepArgs(1));

    expect((result?.providerOptions as any)?.gateway?.only).toEqual(["anthropic"]);
    expect((result?.providerOptions as any)?.anthropic).toBeUndefined();
  });
});
