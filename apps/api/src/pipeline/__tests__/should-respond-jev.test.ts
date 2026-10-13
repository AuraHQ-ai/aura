import { describe, expect, it } from "vitest";
import {
  buildJevRequest,
  decideFromProbability,
  slackTsToIso,
  toGateMessages,
  JEV_MODEL_ID,
} from "../should-respond-jev.js";
import type { SlackThreadMessage } from "../slack-context.js";

const msg = (ts: string, name: string, text: string, isBot = false): SlackThreadMessage => ({
  user: name,
  displayName: name,
  text,
  ts,
  isBot,
});

describe("should-respond Jev gate", () => {
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
    const req = buildJevRequest({
      tier: "participant",
      now: new Date("2026-09-29T08:00:00Z"),
      recent: [msg("1790000000.000000", "Ana", "hello")],
      latest: { ts: "1790000100.000000", from: "Ana", text: "and for Italy?" },
    });
    expect(req.model).toBe(JEV_MODEL_ID);
    expect(req.state.tier).toBe("participant");
    expect(req.state.recent_messages[0].timestamp).toMatch(/^2026-/);
    expect(req.state.latest_message.text).toBe("and for Italy?");
    expect(req.questions.respond.type).toBe("boolean");
  });

  it("applies per-tier thresholds", () => {
    expect(decideFromProbability("participant", 0.42)).toBe(true);
    expect(decideFromProbability("recently_active", 0.42)).toBe(false);
    expect(decideFromProbability("cold", 0.79)).toBe(false);
    expect(decideFromProbability("cold", 0.88)).toBe(true);
  });
});
