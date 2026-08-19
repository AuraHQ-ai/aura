import { describe, expect, it } from "vitest";
import {
  formatRecentDmThreadMessages,
  sanitizeDmThreadTitle,
  selectDmThreadTitle,
} from "../dm-title.js";

describe("DM thread title helpers", () => {
  it("accepts high-confidence titles without language-specific matching", () => {
    expect(
      selectDmThreadTitle({
        title: "Vercel deployment logs",
        confidence: "high",
      }),
    ).toBe("Vercel deployment logs");

    expect(
      selectDmThreadTitle({
        title: "Déploiement Vercel",
        confidence: "high",
      }),
    ).toBe("Déploiement Vercel");

    expect(
      selectDmThreadTitle({
        title: "リリース確認",
        confidence: "high",
      }),
    ).toBe("リリース確認");
  });

  it("rejects low-confidence candidates regardless of their text", () => {
    expect(
      selectDmThreadTitle({
        title: "Valid looking topic",
        confidence: "low",
      }),
    ).toBeNull();
  });

  it("rejects null and structurally invalid titles", () => {
    expect(selectDmThreadTitle({ title: null, confidence: "high" })).toBeNull();
    expect(selectDmThreadTitle({ title: "!", confidence: "high" })).toBeNull();
    expect(selectDmThreadTitle({ title: "a", confidence: "high" })).toBeNull();
  });

  it("normalizes wrappers, whitespace, and trailing punctuation structurally", () => {
    expect(sanitizeDmThreadTitle('  "Pipeline\ninvestigation."  ')).toBe(
      "Pipeline investigation",
    );
  });

  it("formats elided conversation context from both ends of the thread", () => {
    const formatted = formatRecentDmThreadMessages({
      messagesElided: true,
      recentMessages: [
        { displayName: "A", text: "first" },
        { displayName: "B", text: "second" },
        { displayName: "A", text: "third" },
      ],
    });

    expect(formatted).toContain("--- Start of conversation ---");
    expect(formatted).toContain("A: first");
    expect(formatted).toContain("--- ... ---");
    expect(formatted).toContain("A: third");
    expect(formatted).toContain("--- Latest ---");
  });
});
