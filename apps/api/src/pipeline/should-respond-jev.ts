import { experimental_evaluate as evaluate } from "ai";
import type { SlackThreadMessage } from "./slack-context.js";
import {
  finishGenerationObservation,
  startGenerationObservation,
} from "../lib/langfuse.js";

/**
 * Jev (typesafe-ai/jev) powered should-respond gate.
 *
 * Jev is an `evaluation` model: typed answers with calibrated probabilities, no
 * free text, so it cannot return empty output the way a reasoning chat model
 * can (the hy3 incident). We supply the threshold per tier.
 */

export const JEV_MODEL_ID = "typesafe-ai/jev";

/** Gateway request tags for should-respond evaluate/generateText calls. */
export const SHOULD_RESPOND_GATEWAY_TAGS = ["stage:should-respond"] as const;

export const SHOULD_RESPOND_GATEWAY_PROVIDER_OPTIONS = {
  gateway: { tags: [...SHOULD_RESPOND_GATEWAY_TAGS] },
};

export type GateTier = "participant" | "recently_active" | "cold";

/** P(respond) must be >= threshold to reply. Tuned on 9 scenarios; revisit with live data. */
export const JEV_THRESHOLDS: Record<GateTier, number> = {
  participant: 0.35,
  recently_active: 0.5,
  cold: 0.8,
};

const TIER_BAR: Record<GateTier, string> = {
  participant:
    "Aura already sent messages in this thread. Lean true when in doubt.",
  recently_active:
    "Aura was recently active in the channel but is not part of this conversation. Lean false when in doubt.",
  cold:
    "Aura is passively observing. Bar is HIGH: true only for bugs/outages, urgent issues, or explicit questions Aura can answer with data.",
};

export interface JevGateMessage {
  timestamp: string;
  from: string;
  text: string;
}

export interface JevGateInput {
  tier: GateTier;
  now: Date;
  recent: SlackThreadMessage[];
  latest: { ts?: string; from: string; text: string };
}

/** Slack ts ("1790625816.850929") to ISO-8601 UTC; falls back to the raw value. */
export function slackTsToIso(ts: string | undefined): string {
  const n = Number(ts);
  if (!ts || !Number.isFinite(n)) return ts ?? "";
  return new Date(n * 1000).toISOString();
}

export function toGateMessages(
  recent: SlackThreadMessage[],
  latestTs: string | undefined,
  max = 5,
): JevGateMessage[] {
  // The latest message is passed separately; drop it from history if present.
  const history = latestTs ? recent.filter((m) => m.ts !== latestTs) : recent;
  return history.slice(-max).map((m) => ({
    timestamp: slackTsToIso(m.ts),
    from: m.isBot ? "Aura" : m.displayName,
    text: m.text,
  }));
}

export function buildJevRequest(input: JevGateInput) {
  return {
    model: JEV_MODEL_ID,
    state: {
      now: input.now.toISOString(),
      tier: input.tier,
      recent_messages: toGateMessages(input.recent, input.latest.ts),
      latest_message: {
        timestamp: slackTsToIso(input.latest.ts) || input.now.toISOString(),
        from: input.latest.from,
        text: input.latest.text,
      },
    },
    questions: {
      respond: {
        type: "boolean" as const,
        instructions:
          "Should the Slack assistant Aura reply to latest_message? " +
          TIER_BAR[input.tier] +
          " Consider who the message is addressed to, whether it continues a conversation with Aura, and the time gaps between messages.",
        criteria: {
          true: "A question, request, or bug/urgent report that Aura can add value to, or a follow-up to Aura in a conversation with her.",
          false:
            "Acknowledgement, banter, closing pleasantry, or addressed to/between other people.",
        },
      },
    },
  };
}

/** Compact view of the Jev request for Langfuse generation input. */
export function summarizeJevGateInput(
  req: ReturnType<typeof buildJevRequest>,
): { tier: GateTier; now: string; latest: string; recent: string[] } {
  const latest = req.state.latest_message;
  return {
    tier: req.state.tier,
    now: req.state.now,
    latest: `${latest.from}: ${latest.text}`,
    recent: req.state.recent_messages.map((m) => `${m.from}: ${m.text}`),
  };
}

export function decideFromProbability(tier: GateTier, probability: number): boolean {
  return probability >= JEV_THRESHOLDS[tier];
}

export interface JevGateResult {
  respond: boolean;
  probability: number;
  threshold: number;
  latencyMs: number;
}

/** Throws if Jev errors or returns no probability, so callers can fall back. */
export async function jevShouldRespond(
  input: JevGateInput,
  opts?: { telemetry?: { isEnabled: boolean; functionId?: string; metadata?: Record<string, any> } },
): Promise<JevGateResult> {
  const req = buildJevRequest(input);
  let observation = null;
  try {
    observation = startGenerationObservation("should-respond-jev", {
      model: JEV_MODEL_ID,
      input: summarizeJevGateInput(req),
      metadata: { tier: input.tier, engine: "jev" },
    });
  } catch {
    observation = null;
  }
  const startedAt = Date.now();
  try {
    const result: any = await evaluate({
      ...req,
      providerOptions: SHOULD_RESPOND_GATEWAY_PROVIDER_OPTIONS,
      ...(opts?.telemetry ? { telemetry: opts.telemetry } : {}),
    } as any);
    const latencyMs = Date.now() - startedAt;
    const probability = result?.answers?.respond?.probability;
    if (typeof probability !== "number" || Number.isNaN(probability)) {
      throw new Error("Jev returned no probability for respond");
    }
    const gateResult: JevGateResult = {
      respond: decideFromProbability(input.tier, probability),
      probability,
      threshold: JEV_THRESHOLDS[input.tier],
      latencyMs,
    };
    try {
      finishGenerationObservation(observation, {
        output: {
          probability: gateResult.probability,
          threshold: gateResult.threshold,
          respond: gateResult.respond,
        },
        metadata: { tier: input.tier, latencyMs, engine: "jev" },
      });
    } catch {
      // Observability must never throw into the gate path.
    }
    return gateResult;
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    try {
      finishGenerationObservation(observation, {
        level: "ERROR",
        statusMessage: error instanceof Error ? error.message : String(error),
        output: { error: error instanceof Error ? error.message : String(error) },
        metadata: { tier: input.tier, latencyMs, engine: "jev" },
      });
    } catch {
      // Observability must never throw into the gate path.
    }
    throw error;
  }
}
