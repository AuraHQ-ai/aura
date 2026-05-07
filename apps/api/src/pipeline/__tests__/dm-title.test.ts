import { describe, expect, it } from "vitest";
import { isValidTitle, sanitizeTitle } from "../dm-title.js";

describe("DM thread title helpers", () => {
  it("strips wrapping quotes and trailing punctuation", () => {
    expect(sanitizeTitle('"Stripe webhook deduplication."')).toBe(
      "Stripe webhook deduplication",
    );
  });

  it.each([
    "I don't have enough context to identify the core topics...",
    "I'm not sure what to call this",
    "User frustration with excessive automated messaging",
    "Assistant AI profiling and user information retrieval",
    "Sorry, I can't summarize this",
    "SKIP",
    "",
  ])("rejects invalid title: %s", (title) => {
    expect(isValidTitle(title)).toBe(false);
  });

  it.each([
    "FR React crash recap",
    "Outbound BDR reminder",
    "Stripe webhook deduplication",
    "Assistant deployment status",
  ])("accepts valid title: %s", (title) => {
    expect(isValidTitle(title)).toBe(true);
  });
});
