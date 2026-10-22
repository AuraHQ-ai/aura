import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { generateText, MissingToolResultsError } from "ai";
import { MockLanguageModelV3 } from "ai/test";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createUnavailableSurfaceToolApproval,
  ensureToolCallResults,
  INCOMPLETE_TOOL_CALL_ERROR,
  isFailedToolOutput,
  SURFACE_APPROVAL_DENIED_MESSAGE,
} from "./tool-results.js";

function toolCall(
  toolCallId: string,
  toolName = "run_command",
  extra: Record<string, unknown> = {},
) {
  return { type: "tool-call" as const, toolCallId, toolName, input: {}, ...extra };
}

function toolResult(toolCallId: string, toolName = "run_command") {
  return {
    type: "tool-result" as const,
    toolCallId,
    toolName,
    output: { type: "text" as const, value: "ok" },
  };
}

function collectCallIds(messages: Array<ModelMessage>): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as unknown[]) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "tool-call" &&
        (part as { providerExecuted?: boolean }).providerExecuted !== true
      ) {
        ids.push((part as { toolCallId: string }).toolCallId);
      }
    }
  }
  return ids;
}

function collectResultIds(messages: Array<ModelMessage>): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as unknown[]) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "tool-result") {
        ids.add((part as { toolCallId: string }).toolCallId);
      }
    }
  }
  return ids;
}

describe("ensureToolCallResults", () => {
  it("returns the original array when every tool-call already has a result", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [toolCall("toolu_ok")] } as ModelMessage,
      { role: "tool", content: [toolResult("toolu_ok")] } as ModelMessage,
    ];

    const result = ensureToolCallResults(messages);

    expect(result.filled).toEqual([]);
    expect(result.messages).toBe(messages);
  });

  it("fills a dangling tool-call with a synthetic error result", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "run bash" },
      { role: "assistant", content: [toolCall("toolu_dangling", "app_bash")] } as ModelMessage,
    ];

    const result = ensureToolCallResults(messages);

    expect(result.filled).toEqual([
      {
        toolCallId: "toolu_dangling",
        toolName: "app_bash",
        input: {},
        kind: "incomplete",
      },
    ]);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[2]?.role).toBe("tool");
    const part = (result.messages[2]!.content as any[])[0];
    expect(part).toMatchObject({
      type: "tool-result",
      toolCallId: "toolu_dangling",
      toolName: "app_bash",
      output: {
        type: "error-json",
        value: { ok: false, error: INCOMPLETE_TOOL_CALL_ERROR },
      },
    });
  });

  it("appends the synthetic result onto an existing partial tool message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "two tools" },
      {
        role: "assistant",
        content: [toolCall("call_a"), toolCall("call_b")],
      } as ModelMessage,
      { role: "tool", content: [toolResult("call_a")] } as ModelMessage,
    ];

    const result = ensureToolCallResults(messages);

    expect(result.filled.map((f) => f.toolCallId)).toEqual(["call_b"]);
    expect(result.messages).toHaveLength(3);
    const parts = result.messages[2]?.content as any[];
    expect(parts.map((p) => p.toolCallId)).toEqual(["call_a", "call_b"]);
  });

  it("inserts the result before a following user message (try-again history)", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "do it" },
      { role: "assistant", content: [toolCall("toolu_old")] } as ModelMessage,
      { role: "user", content: "Try again" },
    ];

    const result = ensureToolCallResults(messages);

    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect((result.messages[2]!.content as any[])[0].toolCallId).toBe("toolu_old");
  });

  it("skips provider-executed tool-calls", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [toolCall("srvtoolu_bdrk", "code_execution", { providerExecuted: true })],
      } as ModelMessage,
    ];

    const result = ensureToolCallResults(messages);

    expect(result.filled).toEqual([]);
    expect(result.messages).toBe(messages);
  });

  it("uses the surface-approval denial when the call has a tool-approval-request", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "close the lead" },
      {
        role: "assistant",
        content: [
          toolCall("toolu_mcp", "mcp__mako__app_bash"),
          {
            type: "tool-approval-request",
            approvalId: "appr_1",
            toolCall: { toolCallId: "toolu_mcp", toolName: "mcp__mako__app_bash" },
          },
        ],
      } as ModelMessage,
    ];

    const result = ensureToolCallResults(messages);

    expect(result.filled[0]?.kind).toBe("approval");
    const part = (result.messages[2]!.content as any[])[0];
    expect(part.output).toEqual({
      type: "execution-denied",
      reason: SURFACE_APPROVAL_DENIED_MESSAGE,
    });
  });
});

describe("AI_MissingToolResultsError regression", () => {
  const unpaired: ModelMessage[] = [
    { role: "user", content: "run it" },
    { role: "assistant", content: [toolCall("toolu_missing", "app_bash")] } as ModelMessage,
  ];

  it("raises AI_MissingToolResultsError for a tool-call with no result", async () => {
    await expect(
      generateText({
        model: new MockLanguageModelV3(),
        messages: unpaired,
      }),
    ).rejects.toSatisfy((error) => MissingToolResultsError.isInstance(error));
  });

  it("does not raise AI_MissingToolResultsError after the missing result is filled", async () => {
    const filled = ensureToolCallResults(unpaired);
    const callIds = collectCallIds(filled.messages);
    const resultIds = collectResultIds(filled.messages);
    for (const id of callIds) {
      expect(resultIds.has(id)).toBe(true);
    }

    const { text } = await generateText({
      model: new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: "the tool did not complete" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        },
      }),
      messages: filled.messages,
    });

    expect(text).toBe("the tool did not complete");
  });
});

describe("createUnavailableSurfaceToolApproval", () => {
  it("denies tools that declare needsApproval and ignores the rest", () => {
    const approval = createUnavailableSurfaceToolApproval();
    expect(
      approval({
        toolCall: { toolName: "mcp__mako__app_bash", input: { cmd: "ls" } },
        tools: { mcp__mako__app_bash: { needsApproval: true } },
      }),
    ).toEqual({ type: "denied", reason: SURFACE_APPROVAL_DENIED_MESSAGE });
    expect(
      approval({
        toolCall: { toolName: "search_messages" },
        tools: { search_messages: { needsApproval: false } },
      }),
    ).toBeUndefined();
  });
});

describe("isFailedToolOutput", () => {
  it("treats execution-denied and ok:false as failures", () => {
    expect(isFailedToolOutput({ ok: false, error: "nope" })).toBe(true);
    expect(isFailedToolOutput({ type: "execution-denied", reason: "denied" })).toBe(true);
    expect(isFailedToolOutput({ ok: true })).toBe(false);
    expect(isFailedToolOutput("ok")).toBe(false);
  });
});
