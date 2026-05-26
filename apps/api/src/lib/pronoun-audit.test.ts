import { describe, expect, it } from "vitest";
import {
  classifyPronounSummary,
  normalizeGenderToPronounFamily,
  patchSimplePronounMismatch,
  scanPronouns,
} from "./pronoun-audit.js";

describe("normalizeGenderToPronounFamily", () => {
  it("maps known gender labels to pronoun families", () => {
    expect(normalizeGenderToPronounFamily("male")).toBe("masculine");
    expect(normalizeGenderToPronounFamily("female")).toBe("feminine");
    expect(normalizeGenderToPronounFamily("non-binary")).toBe("neutral");
    expect(normalizeGenderToPronounFamily("")).toBeNull();
    expect(normalizeGenderToPronounFamily("unknown-label")).toBeNull();
  });
});

describe("classifyPronounSummary", () => {
  it("returns MATCH when pronouns align with expected family", () => {
    const result = classifyPronounSummary(
      "He runs product and his team trusts him.",
      "masculine",
    );
    expect(result.kind).toBe("MATCH");
  });

  it("returns MISMATCH_SIMPLE when one wrong pronoun family is present", () => {
    const result = classifyPronounSummary(
      "She leads growth and her peers follow her plan.",
      "masculine",
    );
    expect(result.kind).toBe("MISMATCH_SIMPLE");
    if (result.kind === "MISMATCH_SIMPLE") {
      expect(result.sourceFamily).toBe("feminine");
      expect(result.targetFamily).toBe("masculine");
    }
  });

  it("returns MISMATCH_COMPLEX when mixed pronoun families exist", () => {
    const result = classifyPronounSummary(
      "He leads the roadmap and she drives delivery.",
      "masculine",
    );
    expect(result.kind).toBe("MISMATCH_COMPLEX");
  });
});

describe("patchSimplePronounMismatch", () => {
  it("preserves case and applies grammatical hints for her/him/his", () => {
    const patched = patchSimplePronounMismatch(
      "She leads her team and everyone talks to her. HER roadmap is clear.",
      "feminine",
      "masculine",
    );

    expect(patched.summary).toBe(
      "He leads his team and everyone talks to him. HIS roadmap is clear.",
    );
    expect(patched.replacements).toBe(4);
    expect(patched.ambiguousChoices.length).toBe(0);
  });

  it("logs ambiguous choices when context cannot disambiguate possessive/object use", () => {
    const patched = patchSimplePronounMismatch("They spoke with her.", "feminine", "masculine");
    expect(patched.summary).toBe("They spoke with his.");
    expect(patched.ambiguousChoices.length).toBe(1);
    expect(patched.ambiguousChoices[0]).toContain('Ambiguous `her`');
  });
});

describe("scanPronouns", () => {
  it("counts pronoun families using the tracked regex set", () => {
    const result = scanPronouns("She said he helped them with their launch.");
    expect(result.counts.feminine).toBe(1);
    expect(result.counts.masculine).toBe(1);
    expect(result.counts.neutral).toBe(2);
  });
});

describe("patchSimplePronounMismatch ambiguity surfacing", () => {
  it("flags trailing sentence-final `her` as ambiguous in ambiguousChoices", () => {
    // "her" with no following word -> ambiguous (object vs possessive adjective)
    const summary = "The team appreciates her.";
    const result = patchSimplePronounMismatch(summary, "feminine", "masculine");
    expect(result.ambiguousChoices.length).toBeGreaterThan(0);
    expect(result.ambiguousChoices[0]).toContain("Ambiguous");
  });

  it("does NOT flag `her` as ambiguous when followed by a noun (possessive adjective)", () => {
    const summary = "Her team ships fast.";
    const result = patchSimplePronounMismatch(summary, "feminine", "masculine");
    // "her team" - unambiguous possessive adjective
    expect(result.ambiguousChoices).toHaveLength(0);
    expect(result.summary.toLowerCase()).toContain("his team");
  });

  it("does NOT flag `to her` as ambiguous (clear object)", () => {
    const summary = "Joan reports to her weekly.";
    const result = patchSimplePronounMismatch(summary, "feminine", "masculine");
    expect(result.ambiguousChoices).toHaveLength(0);
    expect(result.summary).toContain("to him");
  });
});
