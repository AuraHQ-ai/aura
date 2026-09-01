import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { sanitizeToolCallIds, TOOL_CALL_ID_PATTERN } from "./sanitize-tool-ids.js";

function toolCall(toolCallId: string, toolName = "run_command") {
  return { type: "tool-call" as const, toolCallId, toolName, input: {} };
}

function toolResult(toolCallId: string, toolName = "run_command") {
  return {
    type: "tool-result" as const,
    toolCallId,
    toolName,
    output: { type: "text" as const, value: "ok" },
  };
}

function pairedTurn(toolCallId: string): ModelMessage[] {
  return [
    { role: "assistant", content: [toolCall(toolCallId)] } as ModelMessage,
    { role: "tool", content: [toolResult(toolCallId)] } as ModelMessage,
  ];
}

describe("sanitizeToolCallIds (issue #1376)", () => {
  it("returns the original array untouched when every id is valid and paired", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      ...pairedTurn("toolu_01AbCdEf"),
      { role: "assistant", content: "done" },
    ];

    const result = sanitizeToolCallIds(messages);

    expect(result.changed).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.normalizedIds).toEqual([]);
    expect(result.droppedOrphanedToolResultIds).toEqual([]);
    expect(result.droppedUnpairedToolCallIds).toEqual([]);
  });

  it("round-trips a colon/space-bearing id, rewriting the call and its result identically", () => {
    const rawId = "srvtoolu:bdrk 016DVFjw";
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      ...pairedTurn(rawId),
    ];

    const result = sanitizeToolCallIds(messages);

    expect(result.changed).toBe(true);
    expect(result.normalizedIds).toEqual([
      { raw: rawId, sanitized: "srvtoolu_bdrk_016DVFjw" },
    ]);

    const call = (result.messages[1].content as any[])[0];
    const res = (result.messages[2].content as any[])[0];
    expect(call.toolCallId).toBe("srvtoolu_bdrk_016DVFjw");
    expect(res.toolCallId).toBe(call.toolCallId);
    expect(TOOL_CALL_ID_PATTERN.test(call.toolCallId)).toBe(true);

    // Nothing was dropped: the pair survives sanitization intact.
    expect(result.droppedOrphanedToolResultIds).toEqual([]);
    expect(result.droppedUnpairedToolCallIds).toEqual([]);
  });

  it("truncates ids longer than 64 chars to the provider limit", () => {
    const rawId = "x".repeat(80);
    const result = sanitizeToolCallIds(pairedTurn(rawId));

    const call = (result.messages[0].content as any[])[0];
    const res = (result.messages[1].content as any[])[0];
    expect(call.toolCallId).toHaveLength(64);
    expect(res.toolCallId).toBe(call.toolCallId);
    expect(TOOL_CALL_ID_PATTERN.test(call.toolCallId)).toBe(true);
  });

  it("keeps rewritten ids unique when normalization collides with an existing id", () => {
    const messages: ModelMessage[] = [
      ...pairedTurn("call_a"),
      // Normalizes to "call_a", which is already taken by a valid id.
      ...pairedTurn("call a"),
    ];

    const result = sanitizeToolCallIds(messages);

    const firstCall = (result.messages[0].content as any[])[0];
    const secondCall = (result.messages[2].content as any[])[0];
    const secondResult = (result.messages[3].content as any[])[0];
    expect(firstCall.toolCallId).toBe("call_a");
    expect(secondCall.toolCallId).not.toBe("call_a");
    expect(TOOL_CALL_ID_PATTERN.test(secondCall.toolCallId)).toBe(true);
    expect(secondResult.toolCallId).toBe(secondCall.toolCallId);
  });

  it("drops tool_result blocks with no matching tool_use", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      ...pairedTurn("call_1"),
      { role: "tool", content: [toolResult("call_ghost")] } as ModelMessage,
      { role: "assistant", content: "done" },
    ];

    const result = sanitizeToolCallIds(messages);

    expect(result.changed).toBe(true);
    expect(result.droppedOrphanedToolResultIds).toEqual(["call_ghost"]);
    // The emptied tool message is removed entirely.
    expect(result.messages).toHaveLength(4);
    expect(result.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("drops a tool_use with no matching result in a completed turn, keeping the message's other parts", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running two things." },
          toolCall("call_paired"),
          toolCall("call_unpaired"),
        ],
      } as ModelMessage,
      { role: "tool", content: [toolResult("call_paired")] } as ModelMessage,
      { role: "assistant", content: "done" },
    ];

    const result = sanitizeToolCallIds(messages);

    expect(result.changed).toBe(true);
    expect(result.droppedUnpairedToolCallIds).toEqual(["call_unpaired"]);
    const assistantParts = result.messages[1].content as any[];
    expect(assistantParts).toHaveLength(2);
    expect(assistantParts[0].type).toBe("text");
    expect(assistantParts[1].toolCallId).toBe("call_paired");
  });

  it("keeps an unpaired tool_use in the FINAL message (turn not yet completed)", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [toolCall("call_pending")] } as ModelMessage,
    ];

    const result = sanitizeToolCallIds(messages);

    expect(result.changed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("keeps provider-executed pairs living inside one assistant message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { ...toolCall("srv_1", "toolSearch"), providerExecuted: true },
          toolResult("srv_1", "toolSearch"),
          { type: "text", text: "found it" },
        ],
      } as ModelMessage,
    ];

    const result = sanitizeToolCallIds(messages);

    expect(result.changed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("drops the whole message when every part was a dropped orphan", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool", content: [toolResult("nope_1"), toolResult("nope_2")] } as ModelMessage,
      { role: "assistant", content: "done" },
    ];

    const result = sanitizeToolCallIds(messages);

    expect(result.changed).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(result.droppedOrphanedToolResultIds).toEqual(["nope_1", "nope_2"]);
  });

  it("ignores string-content messages and non-tool parts", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "be nice" },
      { role: "user", content: [{ type: "text", text: "hi" }] } as ModelMessage,
      { role: "assistant", content: "plain text answer" },
    ];

    const result = sanitizeToolCallIds(messages);

    expect(result.changed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("rewrites an id used across multiple results consistently and reports it once", () => {
    const rawId = "call:multi";
    const messages: ModelMessage[] = [
      { role: "assistant", content: [toolCall(rawId)] } as ModelMessage,
      { role: "tool", content: [toolResult(rawId)] } as ModelMessage,
      { role: "tool", content: [toolResult(rawId)] } as ModelMessage,
    ];

    const result = sanitizeToolCallIds(messages);

    expect(result.normalizedIds).toEqual([{ raw: rawId, sanitized: "call_multi" }]);
    const ids = result.messages.flatMap((m) =>
      (m.content as any[]).map((p) => p.toolCallId),
    );
    expect(ids).toEqual(["call_multi", "call_multi", "call_multi"]);
  });
});
