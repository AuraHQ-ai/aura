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

import { withAnthropicFallback } from "./ai.js";

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
