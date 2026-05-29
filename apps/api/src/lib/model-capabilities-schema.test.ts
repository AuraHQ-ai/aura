import { describe, expect, it } from "vitest";
import { ModelCapabilities } from "@aura/db/schema";

describe("ModelCapabilities schema", () => {
  it("accepts valid provider-specific capability shapes", () => {
    expect(
      ModelCapabilities.safeParse({
        provider: "anthropic",
        thinkingMode: "adaptive",
      }).success,
    ).toBe(true);

    expect(
      ModelCapabilities.safeParse({
        provider: "google",
        thinkingBudget: "dynamic",
      }).success,
    ).toBe(true);
  });

  it("rejects malformed provider-specific capability shapes", () => {
    expect(
      ModelCapabilities.safeParse({
        provider: "anthropic",
        reasoningEffort: "high",
      }).success,
    ).toBe(false);

    expect(
      ModelCapabilities.safeParse({
        provider: "openai",
        reasoningEffort: "extreme",
      }).success,
    ).toBe(false);

    expect(
      ModelCapabilities.safeParse({
        provider: "google",
        thinkingBudget: true,
      }).success,
    ).toBe(false);

    expect(
      ModelCapabilities.safeParse({
        thinkingMode: "enabled",
      }).success,
    ).toBe(false);
  });
});
