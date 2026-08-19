import { describe, expect, it } from "vitest";
import { prefilterNotScorable } from "./prefilter.js";
import type { EvalTurn } from "./windowing.js";

function assistantTurn(text: string, overrides: Partial<EvalTurn> = {}): EvalTurn {
  return {
    role: "assistant",
    messageId: "m1",
    partId: "p1",
    traceId: "t1",
    text,
    userId: null,
    createdAt: null,
    toolNames: [],
    ...overrides,
  };
}

describe("prefilterNotScorable", () => {
  it("catches pure acknowledgement turns", () => {
    expect(prefilterNotScorable(assistantTurn("On it."))).toMatchObject({
      rule: "pure_ack",
    });
    expect(prefilterNotScorable(assistantTurn("thanks"))).toMatchObject({
      rule: "pure_ack",
    });
  });

  it("catches obvious progress/status pings", () => {
    expect(prefilterNotScorable(assistantTurn("I'll take a look and get back to you."))).toMatchObject({
      rule: "progress_ping",
    });
    expect(prefilterNotScorable(assistantTurn("Looking into this now"))).toMatchObject({
      rule: "progress_ping",
    });
    expect(
      prefilterNotScorable(
        assistantTurn("Now let me compose and send the digest.", {
          toolNames: ["search_slack"],
        }),
      ),
    ).toMatchObject({
      rule: "operational_status",
    });
  });

  it("catches pure reaction emoji without treating substantive text as a reaction", () => {
    expect(prefilterNotScorable(assistantTurn(":white_check_mark:"))).toMatchObject({
      rule: "pure_reaction",
    });
    expect(prefilterNotScorable(assistantTurn("\u2705"))).toMatchObject({
      rule: "pure_reaction",
    });
    expect(prefilterNotScorable(assistantTurn(":white_check_mark: deployed"))).toBeNull();
  });

  it("keeps terse completed work and tool-backed status visible to the judge", () => {
    expect(prefilterNotScorable(assistantTurn("yes, merged, commit be511f4"))).toBeNull();
    expect(
      prefilterNotScorable(
        assistantTurn("Done", { toolNames: ["github_create_pull_request"] }),
      ),
    ).toBeNull();
  });
});
