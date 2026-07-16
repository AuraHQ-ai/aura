import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../lib/ai.js", () => ({
  getFastModel: vi.fn(async () => "fast-model"),
  getFastModelId: vi.fn(async () => "anthropic/claude-sonnet-test"),
}));

vi.mock("../lib/langfuse.js", () => ({
  withTrace: vi.fn((_attrs: unknown, fn: () => unknown) => fn()),
  aiTelemetry: vi.fn(() => ({ isEnabled: false })),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { judgeWindow, type JudgeEntry } from "./judge.js";
import type { EvalTurn, EvalWindow } from "./windowing.js";

function assistantTurn(partId: string): EvalTurn {
  return {
    role: "assistant",
    messageId: `msg-${partId}`,
    partId,
    traceId: "t1",
    text: `response ${partId}`,
    userId: null,
    createdAt: null,
    toolNames: [],
  };
}

function makeWindow(partIds: string[]): EvalWindow {
  return {
    turns: partIds.map(assistantTurn),
    ownedPartIds: partIds,
  };
}

function entry(partId: string, overrides: Partial<JudgeEntry> = {}): JudgeEntry {
  return {
    part_id: partId,
    scorable: true,
    verdict: "fulfilled",
    failure_class: "none",
    serving_intent: `intent for ${partId}`,
    resolved_in_window: false,
    note: `note for ${partId}`,
    ...overrides,
  };
}

function generateReturning(responses: JudgeEntry[]) {
  return vi.fn(async () => ({ object: { responses } })) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("judgeWindow id mapping (never positional)", () => {
  it("maps verdicts by echoed part_id even when the array is reordered", async () => {
    const window = makeWindow(["aaa", "bbb", "ccc"]);
    // Judge returns entries in scrambled order with distinct verdicts.
    const generate = generateReturning([
      entry("ccc", { verdict: "failed", failure_class: "reasoning" }),
      entry("aaa", { verdict: "fulfilled" }),
      entry("bbb", { verdict: "partial", failure_class: "bad_memory" }),
    ]);

    const result = await judgeWindow(window, { generate });

    expect(result.judged.get("aaa")?.verdict).toBe("fulfilled");
    expect(result.judged.get("bbb")?.verdict).toBe("partial");
    expect(result.judged.get("bbb")?.failureClass).toBe("bad_memory");
    expect(result.judged.get("ccc")?.verdict).toBe("failed");
    expect(result.judged.get("ccc")?.failureClass).toBe("reasoning");
    expect(result.unknownIds).toEqual([]);
    expect(result.omittedIds).toEqual([]);
    expect(result.judgeModel).toBe("anthropic/claude-sonnet-test");
  });

  it("tolerates judges echoing the full [R:...] wrapper", async () => {
    const window = makeWindow(["aaa"]);
    const generate = generateReturning([entry("[R:aaa]", { verdict: "partial", failure_class: "latency" })]);

    const result = await judgeWindow(window, { generate });
    expect(result.judged.get("aaa")?.verdict).toBe("partial");
  });

  it("drops unknown ids instead of misattributing them", async () => {
    const window = makeWindow(["aaa"]);
    const generate = generateReturning([
      entry("aaa"),
      entry("hallucinated-id", { verdict: "failed" }),
    ]);

    const result = await judgeWindow(window, { generate });
    expect(result.judged.size).toBe(1);
    expect(result.unknownIds).toEqual(["hallucinated-id"]);
  });

  it("fills omitted owned ids with non-scorable placeholders so the batch stays idempotent", async () => {
    const window = makeWindow(["aaa", "bbb"]);
    const generate = generateReturning([entry("aaa")]);

    const result = await judgeWindow(window, { generate });

    expect(result.omittedIds).toEqual(["bbb"]);
    const placeholder = result.judged.get("bbb");
    expect(placeholder).toMatchObject({
      scorable: false,
      verdict: null,
      failureClass: "none",
    });
    expect(placeholder?.note).toMatch(/omitted/i);
  });

  it("keeps the first echo when the judge duplicates an id", async () => {
    const window = makeWindow(["aaa"]);
    const generate = generateReturning([
      entry("aaa", { verdict: "fulfilled" }),
      entry("aaa", { verdict: "failed", failure_class: "reasoning" }),
    ]);

    const result = await judgeWindow(window, { generate });
    expect(result.judged.get("aaa")?.verdict).toBe("fulfilled");
  });
});

describe("judgeWindow verdict normalization", () => {
  it("nulls the verdict and failure class on non-scorable turns", async () => {
    const window = makeWindow(["aaa"]);
    const generate = generateReturning([
      entry("aaa", { scorable: false, verdict: "fulfilled", failure_class: "reasoning" }),
    ]);

    const result = await judgeWindow(window, { generate });
    expect(result.judged.get("aaa")).toMatchObject({
      scorable: false,
      verdict: null,
      failureClass: "none",
    });
  });

  it("forces failure class to none on fulfilled verdicts", async () => {
    const window = makeWindow(["aaa"]);
    const generate = generateReturning([
      entry("aaa", { verdict: "fulfilled", failure_class: "bad_harness" }),
    ]);

    const result = await judgeWindow(window, { generate });
    expect(result.judged.get("aaa")?.failureClass).toBe("none");
  });

  it("defaults a missing failure class to none on failed verdicts", async () => {
    const window = makeWindow(["aaa"]);
    const generate = generateReturning([
      entry("aaa", { verdict: "failed", failure_class: null }),
    ]);

    const result = await judgeWindow(window, { generate });
    expect(result.judged.get("aaa")?.failureClass).toBe("none");
  });

  it("passes the rendered transcript and owned markers to the model", async () => {
    const window = makeWindow(["aaa", "bbb"]);
    const generate = generateReturning([entry("aaa"), entry("bbb")]);

    await judgeWindow(window, { generate });

    const callArgs = generate.mock.calls[0][0];
    expect(callArgs.prompt).toContain("[R:aaa]");
    expect(callArgs.prompt).toContain("[R:bbb]");
    expect(callArgs.temperature).toBe(0);
  });

  it("supports honest capability-boundary refusals as partial/fulfilled instead of failed", async () => {
    const window: EvalWindow = {
      turns: [
        {
          role: "user",
          messageId: "u1",
          partId: null,
          traceId: "t1",
          text: "Can you pull the private payroll report?",
          userId: "U123",
          createdAt: null,
          toolNames: [],
        },
        {
          ...assistantTurn("aaa"),
          text: "I can't access payroll because I don't have the required credentials.",
        },
      ],
      ownedPartIds: ["aaa"],
    };
    const generate = generateReturning([
      entry("aaa", {
        verdict: "partial",
        failure_class: "missing_cred",
        note: "Aura honestly identified the missing credential instead of pretending the report was available.",
      }),
    ]);

    const result = await judgeWindow(window, { generate });

    expect(result.judged.get("aaa")).toMatchObject({
      scorable: true,
      verdict: "partial",
      failureClass: "missing_cred",
    });
    const callArgs = generate.mock.calls[0][0];
    expect(callArgs.system).toContain("Honest refusals and capability boundaries");
    expect(callArgs.system).toContain("Use failed only for incorrect, silent, or confabulated behavior");
  });
});
