import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const state = {
    results: [] as unknown[][],
    select: vi.fn(),
  };

  function createQuery() {
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(state.results.shift() ?? []).then(onFulfilled, onRejected),
    };
    return query;
  }

  state.select.mockImplementation(() => createQuery());

  return state;
});

vi.mock("../db/client.js", () => ({
  db: {
    select: dbMock.select,
  },
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  buildStepUsages,
  computeConversationCost,
  resolveCanonicalStepModelId,
} from "./cost-calculator.js";

function queueDbResults(...results: unknown[][]) {
  dbMock.results = [...results];
}

beforeEach(() => {
  queueDbResults();
  vi.clearAllMocks();
});

describe("resolveCanonicalStepModelId", () => {
  it("falls back to the trace model_id when resolved_model_id is missing (issue #1325)", () => {
    expect(
      resolveCanonicalStepModelId({
        canonicalStepModelId: undefined,
        resolvedModelId: undefined,
        fallbackModelId: "anthropic/claude-sonnet-5",
      }),
    ).toBe("anthropic/claude-sonnet-5");
  });

  it("prefers a gateway-format canonical id over the fallback", () => {
    expect(
      resolveCanonicalStepModelId({
        canonicalStepModelId: "anthropic/claude-opus-5",
        resolvedModelId: "claude-opus-5-20260115",
        fallbackModelId: "anthropic/claude-sonnet-5",
      }),
    ).toBe("anthropic/claude-opus-5");
  });

  it("prefers a gateway-format resolved id over the fallback", () => {
    expect(
      resolveCanonicalStepModelId({
        canonicalStepModelId: undefined,
        resolvedModelId: "anthropic/claude-opus-5",
        fallbackModelId: "anthropic/claude-sonnet-5",
      }),
    ).toBe("anthropic/claude-opus-5");
  });
});

describe("buildStepUsages model-id fallback (issue #1325)", () => {
  const usage = { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 };

  it("keeps steps whose provider response carries no modelId, pricing them via the fallback", () => {
    const steps = buildStepUsages(
      [{ usage, response: {} }],
      [],
      "anthropic/claude-sonnet-5",
    );

    expect(steps).toEqual([
      {
        modelId: "anthropic/claude-sonnet-5",
        resolvedModelId: undefined,
        usage: {
          inputTokens: 1_000,
          outputTokens: 500,
          totalTokens: 1_500,
          inputTokenDetails: undefined,
          outputTokenDetails: undefined,
        },
      },
    ]);
  });

  it("does not throw when a step has no response object at all (regression)", () => {
    const steps = buildStepUsages([{ usage }], [], "anthropic/claude-sonnet-5");

    expect(steps).toHaveLength(1);
    expect(steps[0].modelId).toBe("anthropic/claude-sonnet-5");
    expect(steps[0].resolvedModelId).toBeUndefined();
  });

  it("still drops steps with no resolvable model id and no fallback", () => {
    expect(buildStepUsages([{ usage, response: {} }])).toEqual([]);
  });
});

describe("computeConversationCost with fallback-derived model ids", () => {
  it("prices usage from the fallback model_id when resolved_model_id is absent", async () => {
    queueDbResults([
      { tokenType: "input", pricePerMillion: "3" },
      { tokenType: "output", pricePerMillion: "15" },
    ]);

    const steps = buildStepUsages(
      [
        {
          usage: { inputTokens: 1_000_000, outputTokens: 200_000, totalTokens: 1_200_000 },
          response: {},
        },
      ],
      [],
      "anthropic/claude-sonnet-5",
    );

    // Unique asOfDate per test: the pricing cache is module-level and keyed
    // on workspace + model + date.
    const cost = await computeConversationCost(steps, new Date("2026-08-20T00:00:00Z"));

    // 1M input @ $3/M + 200K output @ $15/M
    expect(cost).toBeCloseTo(3 + 3, 6);
  });

  it("returns 0 when no pricing rows exist for the model", async () => {
    queueDbResults([]);

    const cost = await computeConversationCost(
      [
        {
          modelId: "unknown/model-without-pricing",
          usage: { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 },
        },
      ],
      new Date("2026-08-21T00:00:00Z"),
    );

    expect(cost).toBe(0);
  });
});
