import { describe, it, expect, vi } from "vitest";
import type { ModelMessage } from "ai";
import {
  compactMessages,
  COMPACTION_START_STEP,
  COMPACTION_KEEP_RECENT,
  COMPACTION_MAX_RESULT_LENGTH,
  SUMMARIZE_ON_EVICT_MIN_CHARS,
  SUMMARIZE_ON_EVICT_MAX_CHARS,
} from "../pipeline/compact-messages.js";

function makeSystemMessage(text: string): ModelMessage {
  return { role: "system", content: text };
}

function makeUserMessage(text: string): ModelMessage {
  return { role: "user", content: text };
}

function makeToolMessage(
  toolName: string,
  toolCallId: string,
  output: string,
  outputType: "text" | "json" = "text",
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output:
          outputType === "text"
            ? { type: "text", value: output }
            : { type: "json", value: JSON.parse(output) },
      },
    ],
  };
}

function makeAssistantWithToolCall(
  toolName: string,
  toolCallId: string,
): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId,
        toolName,
        input: {},
      },
    ],
  };
}

function buildConversation(stepCount: number, resultLength = 1000): ModelMessage[] {
  const messages: ModelMessage[] = [
    makeSystemMessage("You are a helpful assistant."),
    makeUserMessage("Do the thing."),
  ];

  for (let i = 0; i < stepCount; i++) {
    const id = `call-${i}`;
    messages.push(makeAssistantWithToolCall(`tool_${i}`, id));
    messages.push(
      makeToolMessage(`tool_${i}`, id, "x".repeat(resultLength)),
    );
  }

  return messages;
}

describe("compactMessages", () => {
  it("returns messages unchanged below COMPACTION_START_STEP", async () => {
    const messages = buildConversation(10);
    const result = await compactMessages(messages, COMPACTION_START_STEP - 1);

    expect(result.compactedCount).toBe(0);
    expect(result.estimatedTokensSaved).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("returns messages unchanged at exactly COMPACTION_START_STEP with few messages", async () => {
    const messages = buildConversation(5, 100);
    const result = await compactMessages(messages, COMPACTION_START_STEP);

    expect(result.compactedCount).toBe(0);
  });

  it("compacts old tool results that exceed MAX_RESULT_LENGTH", async () => {
    const messages = buildConversation(40, 1000);
    const result = await compactMessages(messages, 40);

    expect(result.compactedCount).toBeGreaterThan(0);
    expect(result.estimatedTokensSaved).toBeGreaterThan(0);

    const compactedToolMessages = result.messages.filter(
      (m) =>
        m.role === "tool" &&
        Array.isArray(m.content) &&
        m.content.some(
          (p: any) =>
            p.type === "tool-result" &&
            p.output?.type === "text" &&
            p.output.value.startsWith("[Compacted]"),
        ),
    );
    expect(compactedToolMessages.length).toBeGreaterThan(0);
  });

  it("preserves the most recent KEEP_RECENT * 2 messages", async () => {
    const messages = buildConversation(40, 1000);
    const result = await compactMessages(messages, 40);

    const keepFromEnd = COMPACTION_KEEP_RECENT * 2;
    const recentMessages = result.messages.slice(-keepFromEnd);

    for (const msg of recentMessages) {
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "tool-result" && part.output.type === "text") {
            expect(part.output.value).not.toContain("[Compacted]");
          }
        }
      }
    }
  });

  it("never modifies system or user messages", async () => {
    const messages = buildConversation(30, 1000);
    const result = await compactMessages(messages, 30);

    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages[1]).toEqual(messages[1]);
  });

  it("never modifies assistant messages", async () => {
    const messages = buildConversation(30, 1000);
    const result = await compactMessages(messages, 30);

    const assistantMessages = result.messages.filter(
      (m) => m.role === "assistant",
    );
    const originalAssistants = messages.filter((m) => m.role === "assistant");

    expect(assistantMessages).toEqual(originalAssistants);
  });

  it("does not compact tool results under MAX_RESULT_LENGTH", async () => {
    const shortLength = COMPACTION_MAX_RESULT_LENGTH - 10;
    const messages = buildConversation(30, shortLength);
    const result = await compactMessages(messages, 30);

    expect(result.compactedCount).toBe(0);
    expect(result.estimatedTokensSaved).toBe(0);
  });

  it("compacted messages have the correct format", async () => {
    const messages = buildConversation(40, 1000);
    const result = await compactMessages(messages, 40);

    const compactedParts: any[] = [];
    for (const msg of result.messages) {
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (
            part.type === "tool-result" &&
            part.output.type === "text" &&
            part.output.value.startsWith("[Compacted]")
          ) {
            compactedParts.push(part);
          }
        }
      }
    }

    expect(compactedParts.length).toBeGreaterThan(0);
    for (const part of compactedParts) {
      expect(part.output.value).toMatch(
        /^\[Compacted\] .+: .+\.\.\. \[Full result available in conversation trace\]$/,
      );
      expect(part.toolCallId).toBeDefined();
      expect(part.toolName).toBeDefined();
    }
  });

  it("preserves toolCallId and toolName on compacted parts", async () => {
    const messages = buildConversation(40, 1000);
    const result = await compactMessages(messages, 40);

    for (let i = 0; i < result.messages.length; i++) {
      const msg = result.messages[i];
      const orig = messages[i];
      if (msg.role === "tool" && Array.isArray(msg.content) && Array.isArray((orig as any).content)) {
        for (let j = 0; j < msg.content.length; j++) {
          const part = msg.content[j] as any;
          const origPart = (orig as any).content[j];
          if (part.type === "tool-result") {
            expect(part.toolCallId).toBe(origPart.toolCallId);
            expect(part.toolName).toBe(origPart.toolName);
          }
        }
      }
    }
  });

  it("never leaves an orphaned tool-call or tool-result pair", async () => {
    // Anthropic rejects a request outright if any tool_use block lacks its
    // matching tool_result (or vice versa) — compaction must never break the
    // pairing, only shrink the result payload.
    const messages = buildConversation(40, 8000);
    const result = await compactMessages(messages, 40);

    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const msg of result.messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const part of msg.content as any[]) {
        if (part.type === "tool-call") callIds.add(part.toolCallId);
        if (part.type === "tool-result") resultIds.add(part.toolCallId);
      }
    }

    expect(callIds.size).toBeGreaterThan(0);
    expect([...callIds].sort()).toEqual([...resultIds].sort());
  });

  it("handles JSON tool results", async () => {
    const messages: ModelMessage[] = [
      makeSystemMessage("system"),
      makeUserMessage("user"),
    ];

    for (let i = 0; i < 40; i++) {
      const id = `call-${i}`;
      messages.push(makeAssistantWithToolCall(`tool_${i}`, id));
      const jsonData = JSON.stringify({ data: "y".repeat(1000), index: i });
      messages.push(makeToolMessage(`tool_${i}`, id, jsonData, "json"));
    }

    const result = await compactMessages(messages, 40);
    expect(result.compactedCount).toBeGreaterThan(0);

    for (const msg of result.messages) {
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (
            part.type === "tool-result" &&
            part.output.type === "text" &&
            part.output.value.startsWith("[Compacted]")
          ) {
            expect(part.output.value).toContain("[Compacted]");
          }
        }
      }
    }
  });

  it("handles json results whose value stringifies to undefined", async () => {
    // JSON.stringify(undefined) === undefined — must not throw on .length.
    const messages = buildConversation(40, 8000);
    messages[2] = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-undef",
          toolName: "weird_tool",
          output: { type: "json", value: undefined } as any,
        },
      ],
    } as ModelMessage;

    await expect(compactMessages(messages, 40)).resolves.toBeDefined();
  });

  it("does not mutate the original messages array", async () => {
    const messages = buildConversation(40, 1000);
    const originalJson = JSON.stringify(messages);
    await compactMessages(messages, 40);
    expect(JSON.stringify(messages)).toBe(originalJson);
  });

  it("total message count stays the same after compaction", async () => {
    const messages = buildConversation(40, 1000);
    const result = await compactMessages(messages, 40);
    expect(result.messages.length).toBe(messages.length);
  });

  it("keeps input growth roughly linear across a simulated 40-step turn with 8k-char tool results", async () => {
    // Simulates the failure mode behind issue #1328 (the $77.89 turn):
    // every step replays the whole history, so per-step input grows linearly
    // and CUMULATIVE input grows quadratically without compaction. With
    // compaction, per-step input must plateau once the threshold is passed —
    // only the live tail (KEEP_RECENT * 2 messages) plus stubs remain.
    const RESULT_CHARS = 8000;
    const STEPS = 40;

    const inputChars = (msgs: ModelMessage[]) => JSON.stringify(msgs).length;

    const perStepWithout: number[] = [];
    const perStepWith: number[] = [];
    for (let step = 1; step <= STEPS; step++) {
      const history = buildConversation(step, RESULT_CHARS);
      perStepWithout.push(inputChars(history));
      perStepWith.push(inputChars((await compactMessages(history, step)).messages));
    }

    // Without compaction, per-step input keeps growing linearly to the end
    // (≈ 8k chars per additional step → quadratic cumulative input).
    const uncompactedGrowth =
      perStepWithout[STEPS - 1] - perStepWithout[COMPACTION_START_STEP + 4];
    expect(uncompactedGrowth).toBeGreaterThan(
      (STEPS - COMPACTION_START_STEP - 5) * RESULT_CHARS,
    );

    // With compaction, once past the threshold + live tail, adding a step
    // swaps one full 8k result for a stub — per-step input growth collapses
    // to roughly the size of the newly added live messages, so the growth
    // over the same window is a small fraction of the uncompacted one.
    const compactedGrowth =
      perStepWith[STEPS - 1] - perStepWith[COMPACTION_START_STEP + 4];
    expect(compactedGrowth).toBeLessThan(uncompactedGrowth * 0.15);

    // And the cumulative input over the whole turn is substantially smaller.
    // Over just 40 steps the saving is ~35% (compaction starts at step 20 and
    // keeps a KEEP_RECENT * 2 live tail); the ratio keeps improving as turns
    // get longer because the compacted per-step input has plateaued.
    const cumulativeWithout = perStepWithout.reduce((a, b) => a + b, 0);
    const cumulativeWith = perStepWith.reduce((a, b) => a + b, 0);
    expect(cumulativeWith).toBeLessThan(cumulativeWithout * 0.7);
  });
});

describe("summarize-on-evict (issue #1330)", () => {
  const SUMMARY = "42 rows; columns: id, name, total; max total = 913; no errors";

  function collectStubParts(messages: ModelMessage[]): any[] {
    const parts: any[] = [];
    for (const msg of messages) {
      if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
      for (const part of msg.content as any[]) {
        if (
          part.type === "tool-result" &&
          part.output?.type === "text" &&
          (part.output.value.startsWith("[Summarized]") ||
            part.output.value.startsWith("[Compacted]"))
        ) {
          parts.push(part);
        }
      }
    }
    return parts;
  }

  it("summarizes evicted results at or above SUMMARIZE_ON_EVICT_MIN_CHARS", async () => {
    const summarize = vi.fn().mockResolvedValue(SUMMARY);
    const messages = buildConversation(40, SUMMARIZE_ON_EVICT_MIN_CHARS);
    const result = await compactMessages(messages, 40, { summarize });

    expect(summarize).toHaveBeenCalled();
    expect(result.summarizedCount).toBeGreaterThan(0);
    expect(result.summarizedCount).toBe(result.compactedCount);

    const summarized = collectStubParts(result.messages).filter((p) =>
      p.output.value.startsWith("[Summarized]"),
    );
    expect(summarized.length).toBe(result.summarizedCount);
    for (const part of summarized) {
      expect(part.output.value).toContain(part.toolName);
      // The stub must state it is a summary and how much was elided.
      expect(part.output.value).toContain("AI-generated summary");
      expect(part.output.value).toMatch(/\d+-char result \(~\d+ chars elided\)/);
      expect(part.output.value).toContain("Full result available in conversation trace");
      expect(part.output.value).toContain(SUMMARY);
    }
  });

  it("hard-truncates results below the summarize threshold without calling the model", async () => {
    const summarize = vi.fn().mockResolvedValue(SUMMARY);
    // Above the compaction cap (500) but below the summarize threshold:
    // a summary stub would not save enough tokens to pay for the call.
    const messages = buildConversation(40, SUMMARIZE_ON_EVICT_MIN_CHARS - 1);
    const result = await compactMessages(messages, 40, { summarize });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.summarizedCount).toBe(0);
    expect(result.compactedCount).toBeGreaterThan(0);

    const stubs = collectStubParts(result.messages);
    expect(stubs.length).toBeGreaterThan(0);
    for (const part of stubs) {
      expect(part.output.value).toMatch(/^\[Compacted\]/);
    }
  });

  it("hard-truncates enormous results above SUMMARIZE_ON_EVICT_MAX_CHARS without calling the model", async () => {
    const summarize = vi.fn().mockResolvedValue(SUMMARY);
    const messages = buildConversation(25, SUMMARIZE_ON_EVICT_MAX_CHARS + 1);
    const result = await compactMessages(messages, 40, { summarize });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.summarizedCount).toBe(0);
    expect(result.compactedCount).toBeGreaterThan(0);
  });

  it("falls back to hard truncation when the summarization call fails", async () => {
    const summarize = vi.fn().mockRejectedValue(new Error("model unavailable"));
    const messages = buildConversation(40, 8000);
    const result = await compactMessages(messages, 40, { summarize });

    expect(summarize).toHaveBeenCalled();
    expect(result.summarizedCount).toBe(0);
    expect(result.compactedCount).toBeGreaterThan(0);

    const stubs = collectStubParts(result.messages);
    for (const part of stubs) {
      expect(part.output.value).toMatch(/^\[Compacted\]/);
    }
  });

  it("falls back to hard truncation when the summary would not save tokens", async () => {
    // A "summary" nearly as long as the original saves nothing.
    const messages = buildConversation(40, 8000);
    const summarize = vi.fn().mockResolvedValue("s".repeat(7000));
    const result = await compactMessages(messages, 40, { summarize });

    expect(result.summarizedCount).toBe(0);
    expect(result.compactedCount).toBeGreaterThan(0);
  });

  it("memoizes summaries by toolCallId across steps via summaryCache", async () => {
    const summarize = vi.fn().mockResolvedValue(SUMMARY);
    const summaryCache = new Map<string, string>();
    const messages = buildConversation(40, 8000);

    const first = await compactMessages(messages, 40, { summarize, summaryCache });
    const callsAfterFirst = summarize.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Same history on the next step: every summary must come from the cache.
    const second = await compactMessages(messages, 41, { summarize, summaryCache });
    expect(summarize.mock.calls.length).toBe(callsAfterFirst);
    expect(second.summarizedCount).toBe(first.summarizedCount);
  });

  it("passes the tool name and full result text to the summarizer", async () => {
    const summarize = vi.fn().mockResolvedValue(SUMMARY);
    const messages = buildConversation(40, 8000);
    await compactMessages(messages, 40, { summarize });

    const firstCall = summarize.mock.calls[0][0];
    expect(firstCall.toolName).toMatch(/^tool_\d+$/);
    expect(firstCall.text).toBe("x".repeat(8000));
  });

  it("never summarizes results in the recent live tail", async () => {
    const summarize = vi.fn().mockResolvedValue(SUMMARY);
    const messages = buildConversation(40, 8000);
    const result = await compactMessages(messages, 40, { summarize });

    const keepFromEnd = COMPACTION_KEEP_RECENT * 2;
    for (const msg of result.messages.slice(-keepFromEnd)) {
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        for (const part of msg.content as any[]) {
          if (part.type === "tool-result" && part.output?.type === "text") {
            expect(part.output.value).not.toContain("[Summarized]");
          }
        }
      }
    }
  });
});
