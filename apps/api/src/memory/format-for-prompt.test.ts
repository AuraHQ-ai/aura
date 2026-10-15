import { describe, expect, it } from "vitest";
import { formatMemoriesForPrompt } from "./format-for-prompt.js";
import type { Memory } from "@aura/db/schema";

function mem(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    type: "fact",
    content: "Aura's Claap access is broken",
    relatedUserIds: ["joan"],
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    factClass: null,
    ...overrides,
  } as Memory;
}

describe("formatMemoriesForPrompt verify-before-asserting (#1557)", () => {
  it("flags volatile fact classes so the model does not assert them as current", () => {
    const out = formatMemoriesForPrompt(
      [mem({ factClass: "access" })],
      new Date("2026-10-15T00:00:00.000Z"),
    );
    expect(out).toContain("[verify before asserting: access]");
    expect(out).toContain("Claap access is broken");
  });

  it("does not flag durable unclassified memories", () => {
    const out = formatMemoriesForPrompt(
      [mem({ content: "Joan manages the Aura codebase", factClass: null })],
      new Date("2026-10-15T00:00:00.000Z"),
    );
    expect(out).not.toContain("verify before asserting");
  });
});
