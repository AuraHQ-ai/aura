import { describe, expect, it } from "vitest";
import {
  buildTurns,
  buildWindows,
  renderWindowTranscript,
  type EvalTurn,
  type TurnSourceMessage,
  type TurnSourcePart,
  type TurnSourceTrace,
} from "./windowing.js";

function trace(id: string, minute: number, overrides: Partial<TurnSourceTrace> = {}): TurnSourceTrace {
  return {
    id,
    threadTs: "1700000000.000100",
    userId: "U123",
    createdAt: new Date(Date.UTC(2026, 2, 12, 10, minute)),
    ...overrides,
  };
}

function message(
  id: string,
  conversationId: string,
  role: string,
  orderIndex: number,
  content: string | null = null,
): TurnSourceMessage {
  return { id, conversationId, role, content, orderIndex, createdAt: new Date() };
}

function textPart(id: string, messageId: string, orderIndex: number, text: string): TurnSourcePart {
  return { id, messageId, type: "text", orderIndex, textValue: text, toolName: null };
}

function toolPart(id: string, messageId: string, orderIndex: number, toolName: string): TurnSourcePart {
  return { id, messageId, type: "tool-invocation", orderIndex, textValue: null, toolName };
}

function assistantTurn(i: number): EvalTurn {
  return {
    role: "assistant",
    messageId: `m${i}`,
    partId: `p${i}`,
    traceId: "t1",
    text: `response ${i}`,
    userId: null,
    createdAt: null,
    toolNames: [],
  };
}

function userTurn(i: number): EvalTurn {
  return {
    role: "user",
    messageId: `um${i}`,
    partId: null,
    traceId: "t1",
    text: `ask ${i}`,
    userId: "U123",
    createdAt: null,
    toolNames: [],
  };
}

describe("buildTurns", () => {
  it("orders traces chronologically and flattens user/assistant turns", () => {
    const traces = [trace("t2", 5), trace("t1", 0)];
    const messages = [
      message("sys1", "t1", "system", 0, "system prompt"),
      message("u1", "t1", "user", 1, "first ask"),
      message("a1", "t1", "assistant", 2),
      message("u2", "t2", "user", 1, "second ask"),
      message("a2", "t2", "assistant", 2),
    ];
    const parts = [
      textPart("pt-a1", "a1", 1, "first answer"),
      textPart("pt-a2", "a2", 1, "second answer"),
    ];

    const turns = buildTurns(traces, messages, parts);

    expect(turns.map((t) => t.text)).toEqual([
      "first ask",
      "first answer",
      "second ask",
      "second answer",
    ]);
    expect(turns[1]).toMatchObject({
      role: "assistant",
      messageId: "a1",
      partId: "pt-a1",
      traceId: "t1",
    });
  });

  it("folds tool-only relay steps into the next text-bearing assistant turn", () => {
    const traces = [trace("t1", 0)];
    const messages = [
      message("u1", "t1", "user", 0, "look this up"),
      message("a1", "t1", "assistant", 1),
      message("a2", "t1", "assistant", 2),
    ];
    const parts = [
      toolPart("tool1", "a1", 0, "search_slack"),
      toolPart("tool2", "a1", 1, "bigquery"),
      textPart("pt-a2", "a2", 0, "found it"),
      toolPart("tool3", "a2", 1, "post_message"),
    ];

    const turns = buildTurns(traces, messages, parts);

    expect(turns).toHaveLength(2);
    const answer = turns[1];
    expect(answer.partId).toBe("pt-a2");
    expect(answer.toolNames).toEqual(["search_slack", "bigquery", "post_message"]);
  });

  it("falls back to user text parts when message content is empty and skips empty turns", () => {
    const traces = [trace("t1", 0)];
    const messages = [
      message("u1", "t1", "user", 0, null),
      message("u2", "t1", "user", 1, null),
      message("a1", "t1", "assistant", 2),
    ];
    const parts = [
      textPart("pt-u1", "u1", 0, "ask from parts"),
      // u2 has no text anywhere -> dropped
      textPart("pt-a1", "a1", 0, "answer"),
    ];

    const turns = buildTurns(traces, messages, parts);
    expect(turns.map((t) => t.text)).toEqual(["ask from parts", "answer"]);
  });

  it("uses the first text part as the judged part id when a step has several", () => {
    const traces = [trace("t1", 0)];
    const messages = [
      message("u1", "t1", "user", 0, "hi"),
      message("a1", "t1", "assistant", 1),
    ];
    const parts = [
      textPart("pt-first", "a1", 0, "part one"),
      textPart("pt-second", "a1", 2, "part two"),
    ];

    const turns = buildTurns(traces, messages, parts);
    expect(turns[1].partId).toBe("pt-first");
    expect(turns[1].text).toBe("part one\n\npart two");
  });
});

describe("buildWindows", () => {
  it("returns a single window owning everything for short conversations", () => {
    const turns = [userTurn(0), assistantTurn(1), userTurn(2), assistantTurn(3)];
    const windows = buildWindows(turns);

    expect(windows).toHaveLength(1);
    expect(windows[0].turns).toHaveLength(4);
    expect(windows[0].ownedPartIds).toEqual(["p1", "p3"]);
  });

  it("assigns every assistant turn to exactly one window", () => {
    // 50 alternating turns: user, assistant, user, assistant...
    const turns: EvalTurn[] = [];
    for (let i = 0; i < 50; i++) {
      turns.push(i % 2 === 0 ? userTurn(i) : assistantTurn(i));
    }

    const windows = buildWindows(turns);
    const allOwned = windows.flatMap((w) => w.ownedPartIds);
    const expected = turns.filter((t) => t.role === "assistant").map((t) => t.partId);

    // Each assistant turn owned exactly once.
    expect([...allOwned].sort()).toEqual([...(expected as string[])].sort());
    expect(new Set(allOwned).size).toBe(allOwned.length);
    expect(windows.length).toBeGreaterThan(1);
  });

  it("gives owned turns leading AND trailing context across boundaries", () => {
    const turns: EvalTurn[] = [];
    for (let i = 0; i < 50; i++) {
      turns.push(i % 2 === 0 ? userTurn(i) : assistantTurn(i));
    }

    const windows = buildWindows(turns, { stride: 14, lead: 3, trail: 3 });
    const middle = windows[1];

    // The second window's commit region is turns [14, 28); its slice must
    // start 3 turns earlier (the antecedent) and end 3 turns later (the
    // resolution `resolved_in_window` needs).
    expect(middle.turns[0]).toBe(turns[11]);
    expect(middle.turns[middle.turns.length - 1]).toBe(turns[30]);
    // Context extends beyond the owned region on both sides...
    expect(middle.turns.length).toBeGreaterThan(14);
    // ...but lead/trail turns are never owned by this window.
    const owned = new Set(middle.ownedPartIds);
    expect(owned.has(turns[13].partId!)).toBe(false); // lead (owned by window 0)
    expect(owned.has(turns[29].partId!)).toBe(false); // trail (owned by window 2)
    expect(owned.has(turns[15].partId!)).toBe(true); // inside commit region
  });

  it("skips windows that would own no assistant turns", () => {
    const turns = [userTurn(0), userTurn(1), userTurn(2)];
    expect(buildWindows(turns, { stride: 2, lead: 1, trail: 1 })).toHaveLength(0);
  });

  it("clamps degenerate stride/lead/trail values instead of looping forever", () => {
    const turns = [userTurn(0), assistantTurn(1)];
    const windows = buildWindows(turns, { stride: 0, lead: -2, trail: -2 });
    expect(windows.flatMap((w) => w.ownedPartIds)).toEqual(["p1"]);
  });
});

describe("renderWindowTranscript", () => {
  it("injects [R:part_id] markers only for owned turns; context turns get no id", () => {
    const turns = [userTurn(0), assistantTurn(1), assistantTurn(2)];
    const transcript = renderWindowTranscript({
      turns,
      ownedPartIds: ["p2"],
    });

    expect(transcript).toContain("USER U123");
    expect(transcript).not.toContain("[R:p1]");
    expect(transcript).toContain("AURA (context only — do not score)");
    expect(transcript).toContain("[R:p2] AURA");
  });

  it("truncates very long turns in the middle", () => {
    const longTurn = { ...assistantTurn(1), text: "x".repeat(10_000) };
    const transcript = renderWindowTranscript(
      { turns: [longTurn], ownedPartIds: ["p1"] },
      1_000,
    );
    expect(transcript).toContain("[truncated");
    expect(transcript.length).toBeLessThan(2_000);
  });

  it("includes tool names used while producing a response", () => {
    const turn = { ...assistantTurn(1), toolNames: ["bigquery", "bigquery", "search_slack"] };
    const transcript = renderWindowTranscript({ turns: [turn], ownedPartIds: ["p1"] });
    expect(transcript).toContain("(tools used: bigquery, search_slack)");
  });
});
