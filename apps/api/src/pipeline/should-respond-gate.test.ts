import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const getConfigMock = vi.hoisted(() => vi.fn());
const jevShouldRespondMock = vi.hoisted(() => vi.fn());
const generateTextMock = vi.hoisted(() => vi.fn());
const getFastModelMock = vi.hoisted(() => vi.fn());
const withTraceMock = vi.hoisted(() => vi.fn((_attrs: unknown, fn: () => unknown) => fn()));

vi.mock("../lib/logger.js", () => ({
  logger: loggerMocks,
}));

vi.mock("../lib/settings.js", () => ({
  getConfig: getConfigMock,
}));

vi.mock("../lib/ai.js", () => ({
  getFastModel: getFastModelMock,
  withCacheControl: (prompt: string) => prompt,
}));

vi.mock("../lib/langfuse.js", () => ({
  aiTelemetry: vi.fn(() => ({ isEnabled: false })),
  withTrace: withTraceMock,
}));

vi.mock("../tools/slack.js", () => ({
  resolveChannelById: vi.fn(),
}));

vi.mock("./should-respond-jev.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./should-respond-jev.js")>();
  return {
    ...actual,
    jevShouldRespond: jevShouldRespondMock,
  };
});

vi.mock("ai", () => ({
  generateText: generateTextMock,
  Output: { object: (config: unknown) => config },
}));

import { logShouldRespondGate, shouldRespond } from "./context.js";
import type { MessageContext } from "./context.js";
import type { ConversationContext } from "./slack-context.js";

function context(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    text: "can you look at this?",
    userId: "U_ANA",
    channelId: "Cdev",
    channelType: "public_channel",
    messageTs: "1790000100.000000",
    isDm: false,
    isMentioned: false,
    isAddressedByName: false,
    ...overrides,
  };
}

function conversation(
  overrides: Partial<ConversationContext> = {},
): ConversationContext {
  return {
    thread: [
      {
        user: "U_ANA",
        displayName: "Ana",
        text: "can you look at this?",
        ts: "1790000100.000000",
        isBot: false,
      },
    ],
    recentMessages: [],
    isAuraParticipant: true,
    isAuraThread: false,
    auraRecentlyActive: false,
    ...overrides,
  };
}

describe("logShouldRespondGate", () => {
  beforeEach(() => {
    loggerMocks.info.mockReset();
  });

  it("logs engine, tier, probability, threshold, respond, and latencyMs", () => {
    logShouldRespondGate({
      engine: "jev",
      tier: "participant",
      probability: 0.61,
      threshold: 0.35,
      respond: true,
      latencyMs: 88,
    });

    expect(loggerMocks.info).toHaveBeenCalledTimes(1);
    expect(loggerMocks.info).toHaveBeenCalledWith("should-respond gate", {
      engine: "jev",
      tier: "participant",
      probability: 0.61,
      threshold: 0.35,
      respond: true,
      latencyMs: 88,
    });
  });

  it("omits probability and threshold when they are not available", () => {
    logShouldRespondGate({
      engine: "haiku",
      tier: "cold",
      respond: false,
      latencyMs: 12,
    });

    expect(loggerMocks.info).toHaveBeenCalledWith("should-respond gate", {
      engine: "haiku",
      tier: "cold",
      respond: false,
      latencyMs: 12,
    });
  });
});

describe("shouldRespond gate logging", () => {
  beforeEach(() => {
    loggerMocks.info.mockReset();
    loggerMocks.warn.mockReset();
    loggerMocks.error.mockReset();
    getConfigMock.mockReset();
    jevShouldRespondMock.mockReset();
    generateTextMock.mockReset();
    getFastModelMock.mockReset();
    withTraceMock.mockReset();
    withTraceMock.mockImplementation((_attrs: unknown, fn: () => unknown) => fn());
    getConfigMock.mockResolvedValue("jev");
    getFastModelMock.mockResolvedValue({ id: "haiku" });
  });

  it("logs one jev info line and keeps engine:jev / stage:should-respond tags", async () => {
    jevShouldRespondMock.mockResolvedValue({
      respond: true,
      probability: 0.7,
      threshold: 0.35,
      latencyMs: 55,
    });

    const result = await shouldRespond(context(), conversation(), new Set());

    expect(result).toEqual({ respond: true, reason: "thread_participant_llm_yes" });
    expect(loggerMocks.info).toHaveBeenCalledTimes(1);
    expect(loggerMocks.info).toHaveBeenCalledWith("should-respond gate", {
      engine: "jev",
      tier: "participant",
      probability: 0.7,
      threshold: 0.35,
      respond: true,
      latencyMs: 55,
    });
    expect(loggerMocks.warn).not.toHaveBeenCalled();
    expect(withTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.arrayContaining(["stage:should-respond", "engine:jev"]),
      }),
      expect.any(Function),
    );
  });

  it("warns on Jev failure then logs haiku_fallback", async () => {
    jevShouldRespondMock.mockRejectedValue(new Error("jev 503"));
    generateTextMock.mockResolvedValue({ output: { respond: false } });

    const result = await shouldRespond(
      context(),
      conversation({ isAuraParticipant: false, auraRecentlyActive: true }),
      new Set(),
    );

    expect(result.respond).toBe(false);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "Jev gate failed, falling back to fast-model gate",
      expect.objectContaining({ fallback: "haiku_fallback", error: "jev 503", tier: "recently_active" }),
    );
    expect(loggerMocks.info).toHaveBeenCalledTimes(1);
    expect(loggerMocks.info).toHaveBeenCalledWith(
      "should-respond gate",
      expect.objectContaining({
        engine: "haiku_fallback",
        tier: "recently_active",
        respond: false,
      }),
    );
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { gateway: { tags: ["stage:should-respond"] } },
      }),
    );
  });

  it("logs engine=haiku when should_respond_engine is haiku", async () => {
    getConfigMock.mockResolvedValue("haiku");
    generateTextMock.mockResolvedValue({ output: { respond: true } });

    const result = await shouldRespond(context(), conversation(), new Set());

    expect(result.respond).toBe(true);
    expect(jevShouldRespondMock).not.toHaveBeenCalled();
    expect(loggerMocks.info).toHaveBeenCalledTimes(1);
    expect(loggerMocks.info).toHaveBeenCalledWith(
      "should-respond gate",
      expect.objectContaining({ engine: "haiku", tier: "participant", respond: true }),
    );
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it("warns and logs tier_fallback when both engines fail (fail open for participant)", async () => {
    jevShouldRespondMock.mockRejectedValue(new Error("jev down"));
    generateTextMock.mockRejectedValue(new Error("haiku empty"));

    const result = await shouldRespond(context(), conversation(), new Set());

    expect(result).toEqual({ respond: true, reason: "thread_participant_llm_yes" });
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "Jev gate failed, falling back to fast-model gate",
      expect.objectContaining({ fallback: "haiku_fallback", error: "jev down" }),
    );
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "LLM shouldRespond gate failed, falling back to tier",
      expect.objectContaining({ fallback: "tier_fallback", error: "haiku empty", tier: "participant" }),
    );
    expect(loggerMocks.info).toHaveBeenCalledTimes(1);
    expect(loggerMocks.info).toHaveBeenCalledWith(
      "should-respond gate",
      expect.objectContaining({
        engine: "tier_fallback",
        tier: "participant",
        respond: true,
      }),
    );
  });

  it("fail-closes cold observation on tier_fallback", async () => {
    jevShouldRespondMock.mockRejectedValue(new Error("jev down"));
    generateTextMock.mockRejectedValue(new Error("haiku empty"));

    const result = await shouldRespond(
      context(),
      conversation({ isAuraParticipant: false, isAuraThread: false, auraRecentlyActive: false }),
      new Set(),
    );

    expect(result.respond).toBe(false);
    expect(loggerMocks.info).toHaveBeenCalledWith(
      "should-respond gate",
      expect.objectContaining({
        engine: "tier_fallback",
        tier: "cold",
        respond: false,
      }),
    );
  });
});
