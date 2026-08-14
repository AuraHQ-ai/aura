import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gatewayAuthIsInstance: vi.fn(),
  getDefaultModelId: vi.fn(),
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
  getDefaultModelId: mocks.getDefaultModelId,
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

import { withAnthropicFallback, getModelByCategory, isJobModelCategory } from "./ai.js";
import { getSetting } from "./settings.js";

const getSettingMock = vi.mocked(getSetting);

describe("getModelByCategory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingMock.mockResolvedValue(null);
    mocks.getDefaultModelId.mockResolvedValue(null);
  });

  it("resolves the fast category from the DB setting override first", async () => {
    getSettingMock.mockImplementation(async (key: string) =>
      key === "model_fast" ? "openai/gpt-fast-override" : null,
    );

    const { modelId } = await getModelByCategory("fast");

    expect(modelId).toBe("openai/gpt-fast-override");
    expect(getSettingMock).toHaveBeenCalledWith("model_fast");
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("falls back to the catalog default for the category", async () => {
    mocks.getDefaultModelId.mockImplementation(async (category: string) =>
      category === "fast" ? "google/gemini-fast-default" : null,
    );

    const { modelId } = await getModelByCategory("fast");

    expect(modelId).toBe("google/gemini-fast-default");
    expect(mocks.getDefaultModelId).toHaveBeenCalledWith("fast");
  });

  it("resolves the escalation category via its own setting key", async () => {
    getSettingMock.mockImplementation(async (key: string) =>
      key === "model_escalation" ? "openai/gpt-escalation" : null,
    );

    const { modelId } = await getModelByCategory("escalation");

    expect(modelId).toBe("openai/gpt-escalation");
    expect(getSettingMock).toHaveBeenCalledWith("model_escalation");
  });

  it("resolves the main category identically to getMainModel", async () => {
    mocks.getDefaultModelId.mockImplementation(async (category: string) =>
      category === "main" ? "anthropic/claude-main" : null,
    );

    const { modelId } = await getModelByCategory("main");

    expect(modelId).toBe("anthropic/claude-main");
    expect(getSettingMock).toHaveBeenCalledWith("model_main");
  });

  it("throws when neither a setting nor a catalog default exists", async () => {
    await expect(getModelByCategory("fast")).rejects.toThrow(
      "No default model configured for category: fast",
    );
  });
});

describe("isJobModelCategory", () => {
  it("accepts the three job-routable categories", () => {
    expect(isJobModelCategory("main")).toBe(true);
    expect(isJobModelCategory("fast")).toBe(true);
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
