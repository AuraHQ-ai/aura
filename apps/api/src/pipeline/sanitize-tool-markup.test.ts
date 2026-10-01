import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  containsToolCallMarkup,
  createToolMarkupBuffer,
  isLeakedMarkupToolName,
  parseLeakedToolCalls,
  repairLeakedToolCall,
  salvageLeakedToolCall,
  sanitizeAssistantToolMarkup,
  stripToolCallMarkup,
} from "./sanitize-tool-markup.js";

/** Observed GLM leak shape from issue #1515. */
const GLM_LEAK =
  "<tool_call>run_command<arg_key>command</arg_key><arg_value>cat /tmp/lf_traces.json</arg_value></tool_call>";

const GLM_UNCLOSED =
  "<tool_call>run_command<arg_key>command</arg_key><arg_value>cat /tmp/lf_traces.json";

const INVOKE_BLOCK =
  '<invoke name="search_slack"><parameter name="query">deploy failures</parameter></invoke>';

describe("stripToolCallMarkup (issue #1515)", () => {
  it("leaves ordinary assistant prose untouched", () => {
    const text = "I'll look at the traces and report back.";
    expect(stripToolCallMarkup(text)).toEqual({
      text,
      stripped: false,
      samples: [],
    });
    expect(containsToolCallMarkup(text)).toBe(false);
  });

  it("removes a GLM <tool_call>/<arg_key>/<arg_value> block and keeps surrounding prose", () => {
    const text = `I'll check the traces.\n${GLM_LEAK}\nDone.`;
    const result = stripToolCallMarkup(text);
    expect(result.stripped).toBe(true);
    expect(result.text).toContain("I'll check the traces.");
    expect(result.text).toContain("Done.");
    expect(result.text).not.toContain("<tool_call>");
    expect(result.text).not.toContain("<arg_key>");
    expect(result.text).not.toContain("cat /tmp/lf_traces.json");
    expect(result.samples.length).toBeGreaterThan(0);
  });

  it("strips an entire-reply leak (unterminated) down to empty", () => {
    const result = stripToolCallMarkup(GLM_UNCLOSED);
    expect(result.stripped).toBe(true);
    expect(result.text.trim()).toBe("");
  });

  it("strips <invoke> and <function=...> variants", () => {
    expect(stripToolCallMarkup(`Hi ${INVOKE_BLOCK} there`).text).toMatch(/Hi\s+there/);
    expect(
      stripToolCallMarkup('<function=run_command><parameter=command>ls</parameter></function>').text.trim(),
    ).toBe("");
  });
});

describe("parseLeakedToolCalls / salvage (issue #1515)", () => {
  it("parses the GLM arg_key/arg_value shape into a real tool name + input", () => {
    expect(parseLeakedToolCalls(GLM_LEAK)).toEqual([
      { toolName: "run_command", input: { command: "cat /tmp/lf_traces.json" } },
    ]);
  });

  it("parses an unclosed GLM leak", () => {
    expect(parseLeakedToolCalls(GLM_UNCLOSED)).toEqual([
      { toolName: "run_command", input: { command: "cat /tmp/lf_traces.json" } },
    ]);
  });

  it("salvages a native tool-call whose name is the XML blob into a known tool", () => {
    const repaired = salvageLeakedToolCall(
      {
        toolCallId: "call_1",
        toolName: GLM_LEAK,
        input: {},
      },
      { run_command: {} },
    );
    expect(repaired).toEqual({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "run_command",
      input: JSON.stringify({ command: "cat /tmp/lf_traces.json" }),
    });
  });

  it("refuses to execute the XML blob as a tool name when salvage cannot map to a known tool", async () => {
    const repaired = await repairLeakedToolCall({
      toolCall: { toolCallId: "call_1", toolName: GLM_LEAK, input: {} },
      tools: { search_slack: {} },
    });
    expect(repaired).toBeNull();
  });

  it("does not rewrite a genuine unknown tool name", async () => {
    const repaired = await repairLeakedToolCall({
      toolCall: { toolCallId: "call_1", toolName: "not_a_real_tool", input: {} },
      tools: { run_command: {} },
    });
    expect(repaired).toBeNull();
  });

  it("treats any tool name containing < as leaked markup", () => {
    expect(isLeakedMarkupToolName(GLM_LEAK)).toBe(true);
    expect(isLeakedMarkupToolName("run_command")).toBe(false);
    expect(isLeakedMarkupToolName("<tool_call>run_command")).toBe(true);
  });
});

describe("createToolMarkupBuffer (issue #1515)", () => {
  it("holds a split <tool_call> across deltas and never emits the markup", () => {
    const buf = createToolMarkupBuffer();
    expect(buf.push("I'll check.\n<tool_")).toBe("I'll check.\n");
    expect(buf.push("call>run_command<arg_key>command</arg_key>")).toBe("");
    expect(buf.push("<arg_value>cat /tmp/x</arg_value></tool_call>\nDone.")).toBe("\nDone.");
    expect(buf.flush()).toBe("");
    expect(buf.didLeak()).toBe(true);
    expect(buf.samples().join("")).toContain("tool_call");
  });

  it("passes through clean text immediately", () => {
    const buf = createToolMarkupBuffer();
    expect(buf.push("Hello ")).toBe("Hello ");
    expect(buf.push("world.")).toBe("world.");
    expect(buf.flush()).toBe("");
    expect(buf.didLeak()).toBe(false);
  });
});

describe("sanitizeAssistantToolMarkup (issue #1515)", () => {
  it("returns the original array when history is clean", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = sanitizeAssistantToolMarkup(messages);
    expect(result.changed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("strips leaked XML from assistant text and drops XML-named tool-call parts", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "look at the traces" },
      {
        role: "assistant",
        content: [
          { type: "text", text: `Sure.\n${GLM_LEAK}` },
          {
            type: "tool-call",
            toolCallId: "call_xml",
            toolName: GLM_LEAK,
            input: {},
          },
        ],
      } as ModelMessage,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_xml",
            toolName: GLM_LEAK,
            output: { type: "text", value: "nope" },
          },
        ],
      } as ModelMessage,
    ];

    const result = sanitizeAssistantToolMarkup(messages);

    expect(result.changed).toBe(true);
    expect(result.droppedLeakedToolCallIds).toEqual(["call_xml"]);
    const assistant = result.messages.find((m) => m.role === "assistant");
    const text = Array.isArray(assistant?.content)
      ? (assistant?.content as any[]).map((p) => p.text).join("")
      : String(assistant?.content ?? "");
    expect(text).toContain("Sure.");
    expect(text).not.toContain("<tool_call>");
    expect(result.messages.some((m) => m.role === "tool")).toBe(false);
  });
});
