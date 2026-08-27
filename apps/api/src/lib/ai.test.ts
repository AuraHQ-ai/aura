import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gatewayAuthIsInstance: vi.fn(),
  getModelCapabilities: vi.fn(),
  updateModelCapabilities: vi.fn(),
  // Mirrors the real wrapLanguageModel composition: accepts a single
  // middleware or an array (first = outermost), applying transformParams
  // before wrapGenerate/wrapStream at each layer.
  wrapLanguageModel: vi.fn(({ model, middleware }: any) => {
    const middlewares = Array.isArray(middleware) ? middleware : [middleware];
    return [...middlewares].reverse().reduce((wrapped, mw) => {
      const transform = async (params: any, type: string) =>
        mw.transformParams
          ? await mw.transformParams({ params, type, model: wrapped })
          : params;
      return {
        ...wrapped,
        doGenerate: async (params: any) => {
          const transformed = await transform(params, "generate");
          return mw.wrapGenerate
            ? mw.wrapGenerate({
                doGenerate: () => wrapped.doGenerate(transformed),
                params: transformed,
              })
            : wrapped.doGenerate(transformed);
        },
        doStream: async (params: any) => {
          const transformed = await transform(params, "stream");
          return mw.wrapStream
            ? mw.wrapStream({
                doStream: () => wrapped.doStream(transformed),
                params: transformed,
              })
            : wrapped.doStream(transformed);
        },
      };
    }, model);
  }),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    pruneMessages: ({ messages }: any) => messages,
    wrapLanguageModel: mocks.wrapLanguageModel,
    // Use the real middleware so tests exercise the actual stripping logic.
    addToolInputExamplesMiddleware: actual.addToolInputExamplesMiddleware,
  };
});

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

describe("addToolInputExamplesMiddleware — provider boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gatewayAuthIsInstance.mockReturnValue(false);
  });

  it("strips inputExamples and folds them into the description before the provider sees the tools (anthropic model)", async () => {
    const gatewayModel = {
      doGenerate: vi.fn().mockResolvedValue({ ok: true }),
      doStream: vi.fn(),
    };

    const wrapped = withAnthropicFallback(
      gatewayModel as any,
      "anthropic/claude-sonnet-4.5",
    ) as any;

    await wrapped.doGenerate({
      tools: [
        {
          type: "function",
          name: "search",
          description: "Search the web.",
          inputExamples: [{ input: { query: "hello" } }],
        },
      ],
    });

    expect(gatewayModel.doGenerate).toHaveBeenCalledTimes(1);
    const sentTool = gatewayModel.doGenerate.mock.calls[0][0].tools[0];
    expect(sentTool.inputExamples).toBeUndefined();
    expect(sentTool.description).toContain("Search the web.");
    expect(sentTool.description).toContain("Input Examples:");
    expect(sentTool.description).toContain('{"query":"hello"}');
  });

  it("applies to non-Anthropic models too (every model we build)", async () => {
    const gatewayModel = {
      doStream: vi.fn().mockResolvedValue({ ok: true }),
      doGenerate: vi.fn(),
    };

    const wrapped = withAnthropicFallback(
      gatewayModel as any,
      "openai/gpt-test",
    ) as any;

    await wrapped.doStream({
      tools: [
        {
          type: "function",
          name: "search",
          inputExamples: [{ input: { query: "hi" } }],
        },
      ],
    });

    expect(gatewayModel.doStream).toHaveBeenCalledTimes(1);
    const sentTool = gatewayModel.doStream.mock.calls[0][0].tools[0];
    expect(sentTool.inputExamples).toBeUndefined();
    expect(sentTool.description).toContain("Input Examples:");
  });
});

describe("gatewayFallbackMiddleware — unsupported tool field self-heal", () => {
  const EXTRA_INPUTS_ERROR = new Error(
    "GatewayInternalServerError: tools.10.custom.input_examples: Extra inputs are not permitted",
  );

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gatewayAuthIsInstance.mockReturnValue(false);
  });

  it("strips the offending field from every tool and retries once (generate)", async () => {
    const result = { text: "ok" };
    const gatewayModel = {
      doGenerate: vi
        .fn()
        .mockRejectedValueOnce(EXTRA_INPUTS_ERROR)
        .mockResolvedValueOnce(result),
      doStream: vi.fn(),
    };

    const wrapped = withAnthropicFallback(
      gatewayModel as any,
      "anthropic/claude-sonnet-4.5",
    ) as any;

    // Wire-format (snake_case) field name, as reported by the gateway.
    // The examples middleware only handles camelCase inputExamples, so this
    // reaches the fallback middleware and exercises the heal branch.
    await expect(
      wrapped.doGenerate({
        tools: [
          { type: "function", name: "a", input_examples: [{ input: {} }] },
          { type: "function", name: "b" },
          { type: "function", name: "c", input_examples: [{ input: {} }] },
        ],
      }),
    ).resolves.toBe(result);

    expect(gatewayModel.doGenerate).toHaveBeenCalledTimes(2);
    const retryTools = gatewayModel.doGenerate.mock.calls[1][0].tools;
    expect(retryTools).toHaveLength(3);
    for (const tool of retryTools) {
      expect(tool).not.toHaveProperty("input_examples");
      expect(tool).not.toHaveProperty("inputExamples");
    }
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("rejected a tool field"),
      expect.objectContaining({
        field: "input_examples",
        modelId: "anthropic/claude-sonnet-4.5",
      }),
    );
  });

  it("strips the offending field and retries once (stream)", async () => {
    const streamResult = { stream: "ok" };
    const gatewayModel = {
      doGenerate: vi.fn(),
      doStream: vi
        .fn()
        .mockRejectedValueOnce(EXTRA_INPUTS_ERROR)
        .mockResolvedValueOnce(streamResult),
    };

    const wrapped = withAnthropicFallback(
      gatewayModel as any,
      "anthropic/claude-sonnet-4.5",
    ) as any;

    await expect(
      wrapped.doStream({
        tools: [
          { type: "function", name: "a", input_examples: [{ input: {} }] },
        ],
      }),
    ).resolves.toBe(streamResult);

    expect(gatewayModel.doStream).toHaveBeenCalledTimes(2);
    const retryTools = gatewayModel.doStream.mock.calls[1][0].tools;
    expect(retryTools[0]).not.toHaveProperty("input_examples");
  });

  it("finds the error message in a nested cause", async () => {
    const result = { text: "ok" };
    const wrappedError = new Error("gateway request failed");
    (wrappedError as any).cause = new Error(
      "tools.2.custom.input_examples: Extra inputs are not permitted",
    );
    const gatewayModel = {
      doGenerate: vi
        .fn()
        .mockRejectedValueOnce(wrappedError)
        .mockResolvedValueOnce(result),
      doStream: vi.fn(),
    };

    const wrapped = withAnthropicFallback(
      gatewayModel as any,
      "anthropic/claude-sonnet-4.5",
    ) as any;

    await expect(
      wrapped.doGenerate({
        tools: [{ type: "function", name: "a", input_examples: [] }],
      }),
    ).resolves.toBe(result);
    expect(gatewayModel.doGenerate).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-matching errors unchanged without retrying", async () => {
    const error = new Error("boom");
    const gatewayModel = {
      doGenerate: vi.fn().mockRejectedValue(error),
      doStream: vi.fn(),
    };

    const wrapped = withAnthropicFallback(
      gatewayModel as any,
      "anthropic/claude-sonnet-4.5",
    ) as any;

    await expect(
      wrapped.doGenerate({
        tools: [{ type: "function", name: "a", input_examples: [] }],
      }),
    ).rejects.toBe(error);

    expect(gatewayModel.doGenerate).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("rethrows when the error matches but no tool carries the field (retry would be pointless)", async () => {
    const gatewayModel = {
      doGenerate: vi.fn().mockRejectedValue(EXTRA_INPUTS_ERROR),
      doStream: vi.fn(),
    };

    const wrapped = withAnthropicFallback(
      gatewayModel as any,
      "anthropic/claude-sonnet-4.5",
    ) as any;

    await expect(
      wrapped.doGenerate({
        tools: [{ type: "function", name: "a" }],
      }),
    ).rejects.toBe(EXTRA_INPUTS_ERROR);

    expect(gatewayModel.doGenerate).toHaveBeenCalledTimes(1);
  });

  it("does not retry more than once when the retry fails with the same error", async () => {
    const gatewayModel = {
      doGenerate: vi.fn().mockRejectedValue(EXTRA_INPUTS_ERROR),
      doStream: vi.fn(),
    };

    const wrapped = withAnthropicFallback(
      gatewayModel as any,
      "anthropic/claude-sonnet-4.5",
    ) as any;

    await expect(
      wrapped.doGenerate({
        tools: [{ type: "function", name: "a", input_examples: [] }],
      }),
    ).rejects.toBe(EXTRA_INPUTS_ERROR);

    // Initial call + exactly one stripped retry.
    expect(gatewayModel.doGenerate).toHaveBeenCalledTimes(2);
  });
});
