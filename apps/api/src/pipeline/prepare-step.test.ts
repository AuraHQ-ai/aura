import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCapabilities } from "@aura/db/schema";

const catalogMocks = vi.hoisted(() => ({
  getModelCapabilities: vi.fn(),
}));

vi.mock("../lib/model-catalog.js", () => ({
  getModelCapabilities: catalogMocks.getModelCapabilities,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../lib/invocation-lock.js", () => ({
  isInvocationCurrent: vi.fn(),
}));

import {
  getProviderThinkingOptions,
  resolveProviderThinkingOptions,
} from "./prepare-step.js";

function catalogRow(capabilities: ModelCapabilities | null, supportsThinking = true) {
  return {
    found: true,
    supportsThinking,
    tags: supportsThinking ? ["reasoning"] : [],
    capabilities,
  };
}

describe("getProviderThinkingOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves Anthropic adaptive thinking", async () => {
    catalogMocks.getModelCapabilities.mockResolvedValue(
      catalogRow({ provider: "anthropic", thinkingMode: "adaptive" }),
    );

    await expect(getProviderThinkingOptions("anthropic/claude-opus-4.7", 8000))
      .resolves.toEqual({
        anthropic: { thinking: { type: "adaptive" } },
      });
  });

  it("resolves Anthropic enabled thinking with the requested budget", async () => {
    catalogMocks.getModelCapabilities.mockResolvedValue(
      catalogRow({ provider: "anthropic", thinkingMode: "enabled" }),
    );

    await expect(getProviderThinkingOptions("anthropic/claude-opus-4.6", 12000))
      .resolves.toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } },
      });
  });

  it("resolves OpenAI reasoning effort", async () => {
    catalogMocks.getModelCapabilities.mockResolvedValue(
      catalogRow({ provider: "openai", reasoningEffort: "medium" }),
    );

    await expect(getProviderThinkingOptions("openai/gpt-5.1", 8000))
      .resolves.toEqual({
        openai: { reasoningEffort: "medium" },
      });
  });

  it("resolves Google dynamic thinking budget to provider dynamic mode", async () => {
    catalogMocks.getModelCapabilities.mockResolvedValue(
      catalogRow({ provider: "google", thinkingBudget: "dynamic" }),
    );

    await expect(getProviderThinkingOptions("google/gemini-2.5-pro", 8000))
      .resolves.toEqual({
        google: { thinkingConfig: { thinkingBudget: -1 } },
      });
  });

  it("resolves xAI reasoning effort", async () => {
    catalogMocks.getModelCapabilities.mockResolvedValue(
      catalogRow({ provider: "xai", reasoningEffort: "low" }),
    );

    await expect(getProviderThinkingOptions("xai/grok-4-fast-reasoning", 8000))
      .resolves.toEqual({
        xai: { reasoningEffort: "low" },
      });
  });

  it("falls back to enabled thinking for reasoning Anthropic models with null capabilities", () => {
    expect(
      resolveProviderThinkingOptions(
        "anthropic/claude-opus-4.9",
        null,
        8000,
        { found: true, supportsThinking: true },
      ),
    ).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } },
    });
  });

  it("returns no override for non-reasoning null capabilities and unknown providers", () => {
    expect(
      resolveProviderThinkingOptions(
        "anthropic/claude-haiku-4.5",
        null,
        8000,
        { found: true, supportsThinking: false },
      ),
    ).toEqual({});

    expect(
      resolveProviderThinkingOptions(
        "deepseek/deepseek-v3.2-thinking",
        null,
        8000,
        { found: true, supportsThinking: true },
      ),
    ).toEqual({});
  });
});
