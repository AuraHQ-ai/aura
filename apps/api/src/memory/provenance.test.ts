import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CORRECTION_CONFIDENCE,
  DISPUTED_STATUS_MULTIPLIER,
  TRUST_TIER_MULTIPLIERS,
  deriveTrustTier,
  detectCorrectionSignal,
  getFounderUserIds,
  isCapabilityClaim,
  isQuarantinedCapabilityClaim,
  sourceTrustMultiplier,
} from "./provenance.js";

const FOUNDERS = new Set(["U_FOUNDER"]);

function mem(overrides: Record<string, unknown> = {}) {
  return {
    extractionSourceRole: null,
    sourceChannelType: "public_channel",
    relatedUserIds: [] as string[],
    status: "current",
    ...overrides,
  } as Parameters<typeof sourceTrustMultiplier>[0];
}

describe("trust tiers (#950)", () => {
  it("orders tier multipliers founder_dm > user_dm > team_channel > public_channel > assistant_generated", () => {
    const t = TRUST_TIER_MULTIPLIERS;
    expect(t.founder_dm).toBeGreaterThan(t.user_dm);
    expect(t.user_dm).toBeGreaterThan(t.team_channel);
    expect(t.team_channel).toBeGreaterThan(t.public_channel);
    expect(t.public_channel).toBeGreaterThan(t.assistant_generated);
  });

  it("derives founder_dm for DMs involving an admin user", () => {
    expect(
      deriveTrustTier(
        mem({ sourceChannelType: "dm", relatedUserIds: ["U_FOUNDER"] }),
        FOUNDERS,
      ),
    ).toBe("founder_dm");
    expect(
      deriveTrustTier(
        mem({ sourceChannelType: "mpim", relatedUserIds: ["U_FOUNDER", "U_other"] }),
        FOUNDERS,
      ),
    ).toBe("founder_dm");
  });

  it("derives user_dm for non-founder DMs, MPIMs, and dashboard chats", () => {
    expect(
      deriveTrustTier(mem({ sourceChannelType: "dm", relatedUserIds: ["U_x"] }), FOUNDERS),
    ).toBe("user_dm");
    expect(
      deriveTrustTier(mem({ sourceChannelType: "dashboard", relatedUserIds: ["U_x"] }), FOUNDERS),
    ).toBe("user_dm");
  });

  it("derives team_channel for private channels and public_channel otherwise", () => {
    expect(deriveTrustTier(mem({ sourceChannelType: "private_channel" }), FOUNDERS)).toBe(
      "team_channel",
    );
    expect(deriveTrustTier(mem({ sourceChannelType: "public_channel" }), FOUNDERS)).toBe(
      "public_channel",
    );
  });

  it("forces assistant-sourced memories into assistant_generated regardless of channel (#949)", () => {
    expect(
      deriveTrustTier(
        mem({
          extractionSourceRole: "assistant",
          sourceChannelType: "dm",
          relatedUserIds: ["U_FOUNDER"],
        }),
        FOUNDERS,
      ),
    ).toBe("assistant_generated");
  });

  it("keeps user/tool/unknown-sourced memories on their channel tier", () => {
    expect(
      deriveTrustTier(
        mem({ extractionSourceRole: "user", sourceChannelType: "dm", relatedUserIds: ["U_x"] }),
        FOUNDERS,
      ),
    ).toBe("user_dm");
    expect(
      deriveTrustTier(
        mem({ extractionSourceRole: "tool", sourceChannelType: "public_channel" }),
        FOUNDERS,
      ),
    ).toBe("public_channel");
  });

  it("applies the disputed-status demotion on top of the tier multiplier", () => {
    const current = sourceTrustMultiplier(
      mem({ sourceChannelType: "dm", relatedUserIds: ["U_x"] }),
      FOUNDERS,
    );
    const disputed = sourceTrustMultiplier(
      mem({ sourceChannelType: "dm", relatedUserIds: ["U_x"], status: "disputed" }),
      FOUNDERS,
    );
    expect(current).toBe(TRUST_TIER_MULTIPLIERS.user_dm);
    expect(disputed).toBeCloseTo(TRUST_TIER_MULTIPLIERS.user_dm * DISPUTED_STATUS_MULTIPLIER);
  });

  it("ranks an assistant-sourced memory strictly below every user-sourced tier", () => {
    const assistant = sourceTrustMultiplier(
      mem({ extractionSourceRole: "assistant", sourceChannelType: "dm" }),
      FOUNDERS,
    );
    for (const channel of ["dm", "private_channel", "public_channel"] as const) {
      expect(assistant).toBeLessThan(
        sourceTrustMultiplier(mem({ sourceChannelType: channel }), FOUNDERS),
      );
    }
  });
});

describe("getFounderUserIds", () => {
  const original = process.env.AURA_ADMIN_USER_IDS;

  beforeEach(() => {
    process.env.AURA_ADMIN_USER_IDS = " U_A , U_B ,";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.AURA_ADMIN_USER_IDS;
    else process.env.AURA_ADMIN_USER_IDS = original;
  });

  it("parses and trims the comma-separated admin list", () => {
    expect([...getFounderUserIds()].sort()).toEqual(["U_A", "U_B"]);
  });

  it("returns an empty set when unset", () => {
    delete process.env.AURA_ADMIN_USER_IDS;
    expect(getFounderUserIds().size).toBe(0);
  });
});

describe("capability-claim quarantine (#949)", () => {
  it("detects claims about Aura having or lacking access/credentials", () => {
    expect(isCapabilityClaim("Aura does not have access to Mako")).toBe(true);
    expect(isCapabilityClaim("Aura's GitHub PAT is read-only for the aura repo")).toBe(true);
    expect(isCapabilityClaim("Aura lacks a Close API token")).toBe(true);
    expect(isCapabilityClaim("Aura cannot send emails on behalf of the team")).toBe(true);
    expect(isCapabilityClaim("Aura was granted admin access to BigQuery")).toBe(true);
  });

  it("ignores content that is not about Aura or not about capabilities", () => {
    expect(isCapabilityClaim("Joan does not have access to the production database")).toBe(false);
    expect(isCapabilityClaim("Aura recommended the lentil bolognese recipe")).toBe(false);
    expect(isCapabilityClaim("The team decided to use Postgres instead of MongoDB")).toBe(false);
  });

  it("quarantines only assistant-sourced capability claims", () => {
    const content = "Aura does not have access to the Close API";
    expect(
      isQuarantinedCapabilityClaim({ content, extractionSourceRole: "assistant" }),
    ).toBe(true);
    expect(isQuarantinedCapabilityClaim({ content, extractionSourceRole: "user" })).toBe(false);
    expect(isQuarantinedCapabilityClaim({ content, extractionSourceRole: null })).toBe(false);
    expect(
      isQuarantinedCapabilityClaim({
        content: "Aura recommended a hostel in Amsterdam",
        extractionSourceRole: "assistant",
      }),
    ).toBe(false);
  });
});

describe("correction-signal detection (#949)", () => {
  it("detects explicit correction language", () => {
    expect(detectCorrectionSignal("No, actually the deadline is Friday")).toBe(true);
    expect(detectCorrectionSignal("that's wrong — the migration ran on staging")).toBe(true);
    expect(detectCorrectionSignal("You're wrong about the PAT scope")).toBe(true);
    expect(detectCorrectionSignal("you DO have access to Mako")).toBe(true);
    expect(detectCorrectionSignal("it's Postgres, not MongoDB")).toBe(true);
    expect(detectCorrectionSignal("Correction: the launch is in Q3")).toBe(true);
    expect(detectCorrectionSignal("that is no longer true, we switched vendors")).toBe(true);
  });

  it("does not fire on ordinary messages", () => {
    expect(detectCorrectionSignal("can you check the deploy status?")).toBe(false);
    expect(detectCorrectionSignal("thanks, that looks right")).toBe(false);
    expect(detectCorrectionSignal("let's not ship on Friday")).toBe(false);
    expect(detectCorrectionSignal("")).toBe(false);
  });

  it("keeps the correction confidence above the 0.8 default", () => {
    expect(CORRECTION_CONFIDENCE).toBeGreaterThan(0.8);
    expect(CORRECTION_CONFIDENCE).toBeLessThanOrEqual(1);
  });
});
