import { describe, expect, it } from "vitest";
import { buildWindows, isScoringCandidate } from "./window.js";
import type { ConversationTurn, JudgeVerdict } from "./types.js";

function turn(
  partial: Partial<ConversationTurn> & { messageId: string; role: string },
): ConversationTurn {
  return {
    textPartId: null,
    text: "",
    toolSummary: null,
    traceId: "t1",
    threadTs: "thread-1",
    alreadyScored: false,
    createdAt: new Date("2026-03-12T00:00:00Z"),
    ...partial,
  };
}

/** Build an alternating user/assistant transcript of n responses. */
function transcript(n: number, opts: { scored?: number[] } = {}): ConversationTurn[] {
  const scored = new Set(opts.scored ?? []);
  const turns: ConversationTurn[] = [];
  for (let i = 0; i < n; i++) {
    turns.push(turn({ messageId: `u${i}`, role: "user", text: `ask ${i}` }));
    turns.push(
      turn({
        messageId: `a${i}`,
        role: "assistant",
        textPartId: `p${i}`,
        text: `answer ${i}`,
        alreadyScored: scored.has(i),
      }),
    );
  }
  return turns;
}

describe("isScoringCandidate", () => {
  it("only assistant turns with a text part are candidates", () => {
    expect(isScoringCandidate(turn({ messageId: "a", role: "assistant", textPartId: "p" }))).toBe(true);
    expect(isScoringCandidate(turn({ messageId: "a", role: "assistant", textPartId: null }))).toBe(false);
    expect(isScoringCandidate(turn({ messageId: "u", role: "user", textPartId: "p" }))).toBe(false);
  });
});

describe("buildWindows", () => {
  it("owns every candidate exactly once across overlapping windows", () => {
    const turns = transcript(30); // 60 turns, 30 responses
    const windows = buildWindows(turns, { stride: 14, lead: 3, trail: 3 });

    const allOwned = windows.flatMap((w) => w.ownedPartIds);
    // No duplicates — exclusive ownership.
    expect(new Set(allOwned).size).toBe(allOwned.length);
    // Every candidate is owned.
    const expected = Array.from({ length: 30 }, (_, i) => `p${i}`).sort();
    expect([...allOwned].sort()).toEqual(expected);
  });

  it("skips already-scored responses (idempotent)", () => {
    const turns = transcript(10, { scored: [0, 1, 2, 3, 4] });
    const windows = buildWindows(turns);
    const allOwned = windows.flatMap((w) => w.ownedPartIds);
    expect([...allOwned].sort()).toEqual(["p5", "p6", "p7", "p8", "p9"].sort());
  });

  it("produces no windows when everything is already scored", () => {
    const turns = transcript(6, { scored: [0, 1, 2, 3, 4, 5] });
    expect(buildWindows(turns)).toHaveLength(0);
  });

  it("gives owned responses leading + trailing context", () => {
    const turns = transcript(30);
    const windows = buildWindows(turns, { stride: 14, lead: 3, trail: 3 });
    // A middle window must include context turns beyond just its owned region.
    const middle = windows[1];
    expect(middle.context.length).toBeGreaterThan(middle.ownedPartIds.length);
  });
});

describe("id-based verdict mapping (never positional)", () => {
  // Simulates the join the orchestrator does: map verdicts back to turns by the
  // echoed part_id, NOT by array index. A tool-only step or reordered verdict
  // array must still land on the correct response.
  it("maps a shuffled verdict array onto the right responses by id", () => {
    const turns = transcript(3);
    const byPartId = new Map(turns.filter((t) => t.textPartId).map((t) => [t.textPartId!, t]));

    // Judge returns verdicts OUT OF ORDER (positional join would be wrong).
    const verdicts: JudgeVerdict[] = [
      { part_id: "p2", scorable: true, verdict: "failed", serving_intent: "ask 2", resolved_in_window: false, failure_class: "reasoning", note: "wrong" },
      { part_id: "p0", scorable: true, verdict: "fulfilled", serving_intent: "ask 0", resolved_in_window: false, failure_class: "none", note: "ok" },
      { part_id: "p1", scorable: false, verdict: null, serving_intent: "ask 1", resolved_in_window: false, failure_class: "none", note: "ack" },
    ];

    const map = new Map(verdicts.map((v) => [v.part_id, v]));
    expect(map.get(byPartId.get("p0")!.textPartId!)!.verdict).toBe("fulfilled");
    expect(map.get(byPartId.get("p2")!.textPartId!)!.verdict).toBe("failed");
    expect(map.get(byPartId.get("p1")!.textPartId!)!.scorable).toBe(false);
  });

  it("drops hallucinated ids not present in the window", () => {
    const owned = new Set(["p0", "p1"]);
    const verdicts: JudgeVerdict[] = [
      { part_id: "p0", scorable: true, verdict: "fulfilled", serving_intent: "x", resolved_in_window: false, failure_class: "none", note: "" },
      { part_id: "ghost", scorable: true, verdict: "failed", serving_intent: "x", resolved_in_window: false, failure_class: "reasoning", note: "" },
    ];
    const kept = verdicts.filter((v) => owned.has(v.part_id));
    expect(kept).toHaveLength(1);
    expect(kept[0].part_id).toBe("p0");
  });
});
