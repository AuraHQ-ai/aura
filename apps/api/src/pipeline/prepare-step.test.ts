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

describe("createPrepareStep context compaction (issue #1328)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invocationLockMocks.isInvocationCurrent.mockResolvedValue(true);
  });

  function buildLongConversation(stepCount: number, resultLength: number): ModelMessage[] {
    const history: ModelMessage[] = [
      { role: "user", content: "Investigate the thing." },
    ];
    for (let i = 0; i < stepCount; i++) {
      const id = `call-${i}`;
      history.push({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: id, toolName: `tool_${i}`, input: {} }],
      });
      history.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: id,
            toolName: `tool_${i}`,
            output: { type: "text", value: "x".repeat(resultLength) },
          },
        ],
      });
    }
    return history;
  }

  function countCompactedParts(messages: ModelMessage[] | undefined): number {
    let count = 0;
    for (const msg of messages ?? []) {
      if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
      for (const part of msg.content as any[]) {
        if (
          part.type === "tool-result" &&
          part.output?.type === "text" &&
          part.output.value.startsWith("[Compacted]")
        ) {
          count++;
        }
      }
    }
    return count;
  }

  it("compacts old large tool results past COMPACTION_START_STEP and reports stats", async () => {
    const recordCompaction = vi.fn();
    const prepareStep = createPrepareStep({ stablePrefix: "PREFIX", recordCompaction });

    const result = await prepareStep({
      stepNumber: 40,
      steps: [],
      messages: buildLongConversation(40, 8000),
    });

    expect(countCompactedParts(result?.messages)).toBeGreaterThan(0);
    expect(recordCompaction).toHaveBeenCalledTimes(1);
    expect(recordCompaction).toHaveBeenCalledWith({
      stepNumber: 40,
      compactedCount: expect.any(Number),
      estimatedTokensSaved: expect.any(Number),
    });
    expect(recordCompaction.mock.calls[0][0].compactedCount).toBeGreaterThan(0);
    expect(recordCompaction.mock.calls[0][0].estimatedTokensSaved).toBeGreaterThan(0);
  });

  it("does not compact below COMPACTION_START_STEP", async () => {
    const recordCompaction = vi.fn();
    const prepareStep = createPrepareStep({ stablePrefix: "PREFIX", recordCompaction });

    const result = await prepareStep({
      stepNumber: 10,
      steps: [],
      messages: buildLongConversation(40, 8000),
    });

    expect(countCompactedParts(result?.messages)).toBe(0);
    expect(recordCompaction).not.toHaveBeenCalled();
  });

  it("never orphans a tool-call from its tool-result after compaction + pruning", async () => {
    const prepareStep = createPrepareStep({ stablePrefix: "PREFIX" });

    const result = await prepareStep({
      stepNumber: 40,
      steps: [],
      messages: buildLongConversation(40, 8000),
    });

    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const msg of result?.messages ?? []) {
      if (!Array.isArray(msg.content)) continue;
      for (const part of msg.content as any[]) {
        if (part.type === "tool-call") callIds.add(part.toolCallId);
        if (part.type === "tool-result") resultIds.add(part.toolCallId);
      }
    }
    expect(callIds.size).toBeGreaterThan(0);
    expect([...callIds].sort()).toEqual([...resultIds].sort());
  });
});
