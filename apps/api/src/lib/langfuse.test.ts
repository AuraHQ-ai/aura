import { describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { normalizeLangfuseModelSlug } from "./langfuse.js";

describe("normalizeLangfuseModelSlug", () => {
  it("strips provider prefixes and normalizes dotted model versions", () => {
    expect(normalizeLangfuseModelSlug("anthropic/claude-opus-4.8")).toBe(
      "claude-opus-4-8",
    );
    expect(
      normalizeLangfuseModelSlug(["anthropic", "claude-haiku-4.5"].join("/")),
    ).toBe("claude-haiku-4-5");
    expect(normalizeLangfuseModelSlug("openai/gpt-5.1")).toBe("gpt-5-1");
  });

  it("leaves bare dashed slugs intact", () => {
    expect(normalizeLangfuseModelSlug("claude-sonnet-4-6")).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("returns undefined for empty values", () => {
    expect(normalizeLangfuseModelSlug(undefined)).toBeUndefined();
    expect(normalizeLangfuseModelSlug("   ")).toBeUndefined();
  });
});
