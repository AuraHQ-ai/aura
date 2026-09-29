import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackThreadMessage } from "../slack-context.js";

const evaluateMock = vi.hoisted(() => vi.fn());
const startGenerationObservationMock = vi.hoisted(() => vi.fn());
const finishGenerationObservationMock = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({
  experimental_evaluate: evaluateMock,
}));

vi.mock("../../lib/langfuse.js", () => ({
  startGenerationObservation: startGenerationObservationMock,
  finishGenerationObservation: finishGenerationObservationMock,
}));

import {
  buildJevRequest,
  decideFromProbability,
  jevShouldRespond,
  slackTsToIso,
  summarizeJevGateInput,
  toGateMessages,
  JEV_MODEL_ID,
  JEV_THRESHOLDS,
  SHOULD_RESPOND_GATEWAY_PROVIDER_OPTIONS,
  SHOULD_RESPOND_GATEWAY_TAGS,
} from "../should-respond-jev.js";

const msg = (ts: string, name: string, text: string, isBot = false): SlackThreadMessage => ({
  user: name,
  displayName: name,
  text,
  ts,
  isBot,
});

const gateInput = {
  tier: "participant" as const,
  now: new Date("2026-09-29T08:00:00Z"),
  recent: [msg("1790000000.000000", "Ana", "hello")],
  latest: { ts: "1790000100.000000", from: "Ana", text: "and for Italy?" },
};

describe("should-respond Jev gate", () => {
  beforeEach(() => {
    evaluateMock.mockReset();
    startGenerationObservationMock.mockReset();
    finishGenerationObservationMock.mockReset();
    startGenerationObservationMock.mockReturnValue(null);
    finishGenerationObservationMock.mockReturnValue(undefined);
  });

  it("converts Slack ts to ISO", () => {
    expect(slackTsToIso("1790625816.850929")).toBe("2026-09-28T20:03:36.850Z");
  });

  it("drops the latest message from history and keeps last 5", () => {
    const recent = Array.from({ length: 8 }, (_, i) => msg(`${1790000000 + i}.000000`, "Ana", `m${i}`));
    const out = toGateMessages(recent, "1790000007.000000");
    expect(out).toHaveLength(5);
    expect(out[out.length - 1].text).toBe("m6");
  });

  it("labels bot messages as Aura", () => {
    const out = toGateMessages([msg("1790000000.000000", "bot", "hi", true)], undefined);
    expect(out[0].from).toBe("Aura");
  });

  it("builds a request with tier, timestamps and latest message", () => {
    const req = buildJevRequest(gateInput);
    expect(req.model).toBe(JEV_MODEL_ID);
    expect(req.state.tier).toBe("participant");
    expect(req.state.recent_messages[0].timestamp).toMatch(/^2026-/);
    expect(req.state.latest_message.text).toBe("and for Italy?");
    expect(req.questions.respond.type).toBe("boolean");
  });

  it("summarizes the gate request messages for Langfuse input", () => {
    const summary = summarizeJevGateInput(buildJevRequest(gateInput));
    expect(summary.tier).toBe("participant");
    expect(summary.latest).toBe("Ana: and for Italy?");
    expect(summary.recent).toEqual(["Ana: hello"]);
  });

  it("applies per-tier thresholds", () => {
    expect(decideFromProbability("participant", 0.42)).toBe(true);
    expect(decideFromProbability("recently_active", 0.42)).toBe(false);
    expect(decideFromProbability("cold", 0.79)).toBe(false);
    expect(decideFromProbability("cold", 0.88)).toBe(true);
  });

  it("returns latencyMs around the evaluate call", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_042);
    evaluateMock.mockResolvedValue({ answers: { respond: { probability: 0.9 } } });

    const result = await jevShouldRespond(gateInput);

    expect(result.respond).toBe(true);
    expect(result.probability).toBe(0.9);
    expect(result.threshold).toBe(JEV_THRESHOLDS.participant);
    expect(result.latencyMs).toBe(42);
    now.mockRestore();
  });

  it("passes gateway tags on the evaluate call", async () => {
    evaluateMock.mockResolvedValue({ answers: { respond: { probability: 0.4 } } });
    await jevShouldRespond(gateInput);
    expect(evaluateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: SHOULD_RESPOND_GATEWAY_PROVIDER_OPTIONS,
      }),
    );
    expect(SHOULD_RESPOND_GATEWAY_TAGS).toEqual(["stage:should-respond"]);
  });

  it("records a Langfuse generation observation with probability output", async () => {
    const handle = { update: vi.fn(), end: vi.fn() };
    startGenerationObservationMock.mockReturnValue(handle);
    evaluateMock.mockResolvedValue({ answers: { respond: { probability: 0.91 } } });

    const result = await jevShouldRespond(gateInput);

    expect(startGenerationObservationMock).toHaveBeenCalledWith(
      "should-respond-jev",
      expect.objectContaining({
        model: JEV_MODEL_ID,
        input: expect.objectContaining({ latest: "Ana: and for Italy?" }),
        metadata: { tier: "participant", engine: "jev" },
      }),
    );
    expect(finishGenerationObservationMock).toHaveBeenCalledWith(
      handle,
      expect.objectContaining({
        output: {
          probability: 0.91,
          threshold: JEV_THRESHOLDS.participant,
          respond: true,
        },
        metadata: expect.objectContaining({
          tier: "participant",
          engine: "jev",
          latencyMs: result.latencyMs,
        }),
      }),
    );
  });

  it("still returns a decision when Langfuse start/finish throw", async () => {
    startGenerationObservationMock.mockImplementation(() => {
      throw new Error("langfuse down");
    });
    finishGenerationObservationMock.mockImplementation(() => {
      throw new Error("langfuse flush failed");
    });
    evaluateMock.mockResolvedValue({ answers: { respond: { probability: 0.2 } } });

    const result = await jevShouldRespond(gateInput);
    expect(result.respond).toBe(false);
    expect(result.probability).toBe(0.2);
    expect(typeof result.latencyMs).toBe("number");
  });

  it("finishes the observation with ERROR then rethrows when Jev fails", async () => {
    const handle = { update: vi.fn(), end: vi.fn() };
    startGenerationObservationMock.mockReturnValue(handle);
    evaluateMock.mockRejectedValue(new Error("jev timeout"));

    await expect(jevShouldRespond(gateInput)).rejects.toThrow("jev timeout");
    expect(finishGenerationObservationMock).toHaveBeenCalledWith(
      handle,
      expect.objectContaining({
        level: "ERROR",
        statusMessage: "jev timeout",
        metadata: expect.objectContaining({ engine: "jev", tier: "participant" }),
      }),
    );
  });

  it("throws when Jev returns no probability", async () => {
    evaluateMock.mockResolvedValue({ answers: { respond: {} } });
    await expect(jevShouldRespond(gateInput)).rejects.toThrow(
      "Jev returned no probability for respond",
    );
  });
});
