import { describe, expect, it, vi } from "vitest";

const startObservationMock = vi.hoisted(() => vi.fn());

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@langfuse/tracing", () => ({
  startObservation: startObservationMock,
  startActiveObservation: vi.fn((_name: string, fn: () => unknown) => fn()),
  propagateAttributes: vi.fn((_attrs: unknown, fn: () => unknown) => fn()),
}));

import {
  finishGenerationObservation,
  isLangfuseEnabled,
  normalizeLangfuseModelSlug,
  startGenerationObservation,
} from "./langfuse.js";

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

describe("manual generation observations", () => {
  it("is a no-op when Langfuse is not configured", () => {
    expect(isLangfuseEnabled()).toBe(false);
    expect(
      startGenerationObservation("should-respond-jev", {
        model: "typesafe-ai/jev",
        input: { latest: "Ana: hi" },
        metadata: { engine: "jev" },
      }),
    ).toBeNull();
    expect(startObservationMock).not.toHaveBeenCalled();
  });

  it("finishGenerationObservation is a no-op for a null handle", () => {
    expect(() =>
      finishGenerationObservation(null, { output: { respond: true } }),
    ).not.toThrow();
  });

  it("finishGenerationObservation swallows update/end errors", () => {
    const handle = {
      update: vi.fn(() => {
        throw new Error("update failed");
      }),
      end: vi.fn(),
    };
    expect(() =>
      finishGenerationObservation(handle, { output: { respond: false } }),
    ).not.toThrow();
  });
});
