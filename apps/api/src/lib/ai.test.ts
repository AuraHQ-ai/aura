import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gatewayAuthIsInstance: vi.fn(),
  getModelCapabilities: vi.fn(),
  updateModelCapabilities: vi.fn(),
  wrapLanguageModel: vi.fn(({ model, middleware }: any) => ({
    ...model,
    doGenerate: (params: any) =>
      middleware.wrapGenerate({
        doGenerate: () => model.doGenerate(params),
        params,
      }),
    doStream: (params: any) =>
      middleware.wrapStream({
        doStream: () => model.doStream(params),
        params,
      }),
  })),
}));

vi.mock("ai", () => ({
  pruneMessages: ({ messages }: any) => messages,
  wrapLanguageModel: mocks.wrapLanguageModel,
}));

vi.mock("@ai-sdk/gateway", () => ({
  gateway: vi.fn(),
  GatewayAuthenticationError: {
    isInstance: mocks.gatewayAuthIsInstance,
  },
}));

vi.mock("./settings.js", () => ({
  getSetting: vi.fn(),
}));

vi.mock("./model-catalog.js", () => ({
  getModelCapabilities: mocks.getModelCapabilities,
  updateModelCapabilities: mocks.updateModelCapabilities,
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./invocation-lock.js", () => ({
  isInvocationCurrent: vi.fn(),
}));

import { withAnthropicFallback, getModelByCategory, isJobModelCategory, LAST_RESORT_MODELS } from "./ai.js";
import { getSetting } from "./settings.js";
import { logger } from "./logger.js";

const getSettingMock = vi.mocked(getSetting);
const loggerWarnMock = vi.mocked(logger.warn);

describe("getModelByCategory — resolution order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingMock.mockResolvedValue(null);
  });

  // Requirement: present settings row → used directly, no fallback
  it("uses the DB settings row when present (fast)", async () => {
    getSettingMock.mockImplementation(async (key: string) =>
      key === "model_fast" ? "openai/gpt-fast-override" : null,
    );

    const { modelId } = await getModelByCategory("fast");

    expect(modelId).toBe("openai/gpt-fast-override");
    expect(getSettingMock).toHaveBeenCalledWith("model_fast");
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("uses the DB settings row when present (escalation)", async () => {
    getSettingMock.mockImplementation(async (key: string) =>
      key === "model_escalation" ? "openai/gpt-escalation" : null,
    );

    const { modelId } = await getModelByCategory("escalation");

    expect(modelId).toBe("openai/gpt-escalation");
    expect(getSettingMock).toHaveBeenCalledWith("model_escalation");
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("uses the DB settings row when present (medium)", async () => {
    getSettingMock.mockImplementation(async (key: string) =>
      key === "model_medium" ? "anthropic/claude-medium-override" : null,
    );

    const { modelId } = await getModelByCategory("medium");

    expect(modelId).toBe("anthropic/claude-medium-override");
    expect(getSettingMock).toHaveBeenCalledWith("model_medium");
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("uses the DB settings row when present (main)", async () => {
    getSettingMock.mockImplementation(async (key: string) =>
      key === "model_main" ? "anthropic/claude-main-override" : null,
    );

    const { modelId } = await getModelByCategory("main");

    expect(modelId).toBe("anthropic/claude-main-override");
    expect(getSettingMock).toHaveBeenCalledWith("model_main");
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  // Requirement: missing settings row → hardcoded LAST_RESORT_MODELS fallback + warning
  it("falls back to LAST_RESORT_MODELS and logs a warning when no settings row exists (fast)", async () => {
    const { modelId } = await getModelByCategory("fast");

    expect(modelId).toBe(LAST_RESORT_MODELS.fast);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "No DB setting for model category, using last-resort default",
      expect.objectContaining({ category: "fast", fallback: LAST_RESORT_MODELS.fast }),
    );
  });

  it("falls back to LAST_RESORT_MODELS and logs a warning when no settings row exists (main)", async () => {
    const { modelId } = await getModelByCategory("main");

    expect(modelId).toBe(LAST_RESORT_MODELS.main);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "No DB setting for model category, using last-resort default",
      expect.objectContaining({ category: "main", fallback: LAST_RESORT_MODELS.main }),
    );
  });

  it("falls back to LAST_RESORT_MODELS.medium when no settings row exists (not main)", async () => {
    const { modelId } = await getModelByCategory("medium");

    expect(modelId).toBe(LAST_RESORT_MODELS.medium);
    // Must NOT fall through to the main setting key
    expect(getSettingMock).not.toHaveBeenCalledWith("model_main");
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "No DB setting for model category, using last-resort default",
      expect.objectContaining({ category: "medium" }),
    );
  });

  // Requirement: unknown category → throws
  it("throws for an unknown category (not in LAST_RESORT_MODELS)", async () => {
    await expect(
      getModelByCategory("unknown_category" as any),
    ).rejects.toThrow("No last-resort model configured for unknown category: unknown_category");
  });
});

describe("isJobModelCategory", () => {
  it("accepts the four job-routable categories", () => {
    expect(isJobModelCategory("main")).toBe(true);
    expect(isJobModelCategory("fast")).toBe(true);
    expect(isJobModelCategory("medium")).toBe(true);
    expect(isJobModelCategory("escalation")).toBe(true);
  });

  it("rejects embedding, null, and arbitrary strings", () => {
    expect(isJobModelCategory("embedding")).toBe(false);
    expect(isJobModelCategory(null)).toBe(false);
    expect(isJobModelCategory(undefined)).toBe(false);
    expect(isJobModelCategory("gpt-4")).toBe(false);
  });
});

describe("withAnthropicFallback thinking self-heal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gatewayAuthIsInstance.mockReturnValue(false);
    mocks.updateModelCapabilities.mockResolvedValue(true);
  });

  it("persists adaptive Anthropic capabilities and retries stream with corrected options", async () => {
    const streamResult = { stream: "ok" };
    const gatewayModel = {
      doGenerate: vi.fn(),
      doStream: vi
        .fn()
        .mockRejectedValueOnce(
          new Error("\"thinking.type.enabled\" is not supported for this model"),
        )
        .mockResolvedValueOnce(streamResult),
    };
    mocks.getModelCapabilities.mockResolvedValue({
      found: true,
      supportsThinking: true,
      tags: ["reasoning"],
      capabilities: { provider: "anthropic", thinkingMode: "adaptive" },
    });

    const wrapped = withAnthropicFallback(
      gatewayModel as any,
      "anthropic/claude-opus-4.7",
    ) as any;

    await expect(
      wrapped.doStream({
        providerOptions: {
          anthropic: {
            thinking: { type: "enabled", budgetTokens: 4096 },
            cacheControl: { type: "ephemeral" },
          },
        },
      }),
    ).resolves.toBe(streamResult);

    expect(mocks.updateModelCapabilities).toHaveBeenCalledWith(
      "anthropic/claude-opus-4.7",
      { provider: "anthropic", thinkingMode: "adaptive" },
    );
    expect(gatewayModel.doStream).toHaveBeenCalledTimes(2);
    expect(gatewayModel.doStream).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerOptions: {
          anthropic: {
            thinking: { type: "adaptive" },
            cacheControl: { type: "ephemeral" },
          },
        },
      }),
    );
  });
});
