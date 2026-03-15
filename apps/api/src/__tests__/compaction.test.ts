import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  compactMessages,
  COMPACTION_START_STEP,
  COMPACTION_KEEP_RECENT,
  COMPACTION_MAX_RESULT_LENGTH,
} from "../pipeline/compact-messages.js";

function makeSystemMessage(text: string): ModelMessage {
  return { role: "system", content: text };
}

function makeUserMessage(text: string): ModelMessage {
  return { role: "user", content: text };
}

function makeAssistantMessage(text: string): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
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
  it("returns messages unchanged below COMPACTION_START_STEP", () => {
    const messages = buildConversation(10);
    const result = compactMessages(messages, COMPACTION_START_STEP - 1);

    expect(result.compactedCount).toBe(0);
    expect(result.estimatedTokensSaved).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("returns messages unchanged at exactly COMPACTION_START_STEP with few messages", () => {
    const messages = buildConversation(5, 100);
    const result = compactMessages(messages, COMPACTION_START_STEP);

    expect(result.compactedCount).toBe(0);
  });

  it("compacts old tool results that exceed MAX_RESULT_LENGTH", () => {
    const longText = "a".repeat(1000);
    const messages = buildConversation(40, 1000);
    const result = compactMessages(messages, 40);

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

  it("preserves the most recent KEEP_RECENT * 2 messages", () => {
    const messages = buildConversation(40, 1000);
    const result = compactMessages(messages, 40);

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

  it("never modifies system or user messages", () => {
    const messages = buildConversation(30, 1000);
    const result = compactMessages(messages, 30);

    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages[1]).toEqual(messages[1]);
  });

  it("never modifies assistant messages", () => {
    const messages = buildConversation(30, 1000);
    const result = compactMessages(messages, 30);

    const assistantMessages = result.messages.filter(
      (m) => m.role === "assistant",
    );
    const originalAssistants = messages.filter((m) => m.role === "assistant");

    expect(assistantMessages).toEqual(originalAssistants);
  });

  it("does not compact tool results under MAX_RESULT_LENGTH", () => {
    const shortLength = COMPACTION_MAX_RESULT_LENGTH - 10;
    const messages = buildConversation(30, shortLength);
    const result = compactMessages(messages, 30);

    expect(result.compactedCount).toBe(0);
    expect(result.estimatedTokensSaved).toBe(0);
  });

  it("compacted messages have the correct format", () => {
    const messages = buildConversation(40, 1000);
    const result = compactMessages(messages, 40);

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

  it("preserves toolCallId and toolName on compacted parts", () => {
    const messages = buildConversation(40, 1000);
    const result = compactMessages(messages, 40);

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

  it("handles JSON tool results", () => {
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

    const result = compactMessages(messages, 40);
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

  it("does not mutate the original messages array", () => {
    const messages = buildConversation(40, 1000);
    const originalJson = JSON.stringify(messages);
    compactMessages(messages, 40);
    expect(JSON.stringify(messages)).toBe(originalJson);
  });

  it("total message count stays the same after compaction", () => {
    const messages = buildConversation(40, 1000);
    const result = compactMessages(messages, 40);
    expect(result.messages.length).toBe(messages.length);
  });
});
