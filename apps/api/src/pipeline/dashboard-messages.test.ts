import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { appendPendingUserMessage, sanitizeAssistantPartOrder } from "./dashboard-messages.js";

function userMsg(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

function assistantMsg(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] } as UIMessage;
}

describe("appendPendingUserMessage", () => {
  it("appends the in-flight user bubble for a fresh session", () => {
    const restored = [userMsg("u1", "first"), assistantMsg("a1", "reply")];
    const result = appendPendingUserMessage(restored, "second question", "run-1");

    expect(result).toHaveLength(3);
    expect(result[2]).toMatchObject({
      id: "pending-user-run-1",
      role: "user",
      parts: [{ type: "text", text: "second question" }],
    });
    // input untouched
    expect(restored).toHaveLength(2);
  });

  it("returns messages unchanged when there is no pending text", () => {
    const restored = [userMsg("u1", "hi")];
    expect(appendPendingUserMessage(restored, null, "run-1")).toBe(restored);
    expect(appendPendingUserMessage(restored, undefined, "run-1")).toBe(restored);
    expect(appendPendingUserMessage(restored, "", "run-1")).toBe(restored);
  });

  it("does not duplicate the bubble when the transcript already ends with it", () => {
    // The originating tab appends the user message locally before sending.
    const restored = [assistantMsg("a1", "reply"), userMsg("u2", "second question")];
    const result = appendPendingUserMessage(restored, "second question", "run-1");
    expect(result).toBe(restored);
  });

  it("appends when the trailing user message differs from the pending one", () => {
    const restored = [userMsg("u1", "older question")];
    const result = appendPendingUserMessage(restored, "newer question", "run-2");
    expect(result).toHaveLength(2);
    expect(result[1]?.id).toBe("pending-user-run-2");
  });

  it("appends on an empty transcript (brand-new thread, fresh session)", () => {
    const result = appendPendingUserMessage([], "hello", "run-3");
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("user");
  });
});

describe("sanitizeAssistantPartOrder", () => {
  it("moves text before tool parts and drops step-start", () => {
    const messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "dynamic-tool", toolName: "t", toolCallId: "c1", state: "output-available", input: {}, output: {} },
          { type: "text", text: "answer" },
        ],
      } as unknown as UIMessage,
    ];

    const [sanitized] = sanitizeAssistantPartOrder(messages);
    const types = (sanitized!.parts as Array<{ type: string }>).map((p) => p.type);
    expect(types).toEqual(["text", "dynamic-tool"]);
  });

  it("strips reasoning from non-final assistant messages only", () => {
    const messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "old thinking" },
          { type: "text", text: "first" },
        ],
      },
      {
        id: "a2",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "new thinking" },
          { type: "text", text: "second" },
        ],
      },
    ] as unknown as UIMessage[];

    const sanitized = sanitizeAssistantPartOrder(messages);
    expect((sanitized[0]!.parts as Array<{ type: string }>).map((p) => p.type)).toEqual(["text"]);
    expect((sanitized[1]!.parts as Array<{ type: string }>).map((p) => p.type)).toEqual([
      "reasoning",
      "text",
    ]);
  });
});
