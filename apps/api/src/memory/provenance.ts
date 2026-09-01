/**
 * Provenance-aware retrieval scoring (#949) and source trust tiers (#950).
 *
 * Memories extracted from Aura's OWN assistant turns must not carry the same
 * retrieval authority as memories extracted from what a human actually said —
 * otherwise a confabulated claim ("I don't have access to X") gets stored,
 * retrieved as fact, re-asserted, and re-extracted in a self-reinforcing loop.
 *
 * All tier definitions and weights live HERE as named constants so they're
 * tunable in one place. Retrieval (retrieve.ts) consumes them as score
 * multipliers applied before the rerank cut; extraction (extract.ts) consumes
 * the correction-signal and capability-claim detectors.
 */

import type { Memory } from "@aura/db/schema";

// ── Source trust tiers (#950) ────────────────────────────────────────────────

/**
 * Trust tier of a memory's source, derived at retrieval time from columns
 * that already exist (`extraction_source_role`, `source_channel_type`,
 * `related_user_ids`) — no schema change or backfill required.
 *
 * Ordering (most → least authoritative):
 * founder_dm > user_dm > team_channel > public_channel > assistant_generated
 */
export type TrustTier =
  | "founder_dm"
  | "user_dm"
  | "team_channel"
  | "public_channel"
  | "assistant_generated";

/**
 * Score multipliers per trust tier. Deliberately mild (0.70–1.00): trust is a
 * ranking prior, not a hard filter — a genuinely relevant low-trust memory can
 * still surface, it just can't crowd out an equally relevant high-trust one.
 * Tune here, nowhere else.
 */
export const TRUST_TIER_MULTIPLIERS: Record<TrustTier, number> = {
  /** DM with a founder/admin (AURA_ADMIN_USER_IDS) — highest authority. */
  founder_dm: 1.0,
  /** DM/MPIM with any other user, or the authenticated dashboard chat. */
  user_dm: 0.95,
  /** Private channel — team members only. */
  team_channel: 0.9,
  /** Public channel — anyone in the workspace can write here. */
  public_channel: 0.85,
  /**
   * Extracted from Aura's own assistant turn (#949 provenance asymmetry).
   * Lowest tier regardless of channel: Aura's own assertions are not
   * independent evidence.
   */
  assistant_generated: 0.7,
};

/**
 * Extra demotion for `status='disputed'` memories. A disputed memory stays in
 * the candidate pool (it may still be the best answer) but ranks below an
 * undisputed memory of equal relevance. Correction-signal handling
 * (extract.ts) marks corrected-away assistant claims as disputed, so this is
 * what "demote the corrected-away memory" means at retrieval time.
 */
export const DISPUTED_STATUS_MULTIPLIER = 0.6;

/**
 * Confidence stamped on user-sourced memories written while an explicit
 * correction signal is present ("no, actually...", "that's wrong"). Above the
 * 0.8 default so the corrected fact outranks what it corrects (the rerank
 * path multiplies by `0.9 + 0.1 * confidence`).
 */
export const CORRECTION_CONFIDENCE = 0.95;

/**
 * Cosine-similarity floor when sweeping for the assistant-sourced claims a
 * user correction is correcting. High enough to only hit same-topic claims,
 * low enough that a negated restatement ("does have" vs "does not have")
 * still matches.
 */
export const CORRECTION_DISPUTE_SIM_FLOOR = 0.6;

/** Parse founder/admin Slack user IDs from AURA_ADMIN_USER_IDS. */
export function getFounderUserIds(): Set<string> {
  return new Set(
    (process.env.AURA_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

type TrustTierInput = Pick<
  Memory,
  "extractionSourceRole" | "sourceChannelType" | "relatedUserIds"
>;

/**
 * Derive the trust tier for a memory from its existing provenance columns.
 *
 * Assistant-sourced memories are always `assistant_generated` — the channel
 * they were uttered in doesn't make Aura's own assertion more trustworthy.
 */
export function deriveTrustTier(
  memory: TrustTierInput,
  founderIds: Set<string> = getFounderUserIds(),
): TrustTier {
  if (memory.extractionSourceRole === "assistant") return "assistant_generated";

  switch (memory.sourceChannelType) {
    case "dm":
    case "mpim":
    case "dashboard": {
      const related = memory.relatedUserIds ?? [];
      return related.some((id) => founderIds.has(id)) ? "founder_dm" : "user_dm";
    }
    case "private_channel":
      return "team_channel";
    default:
      return "public_channel";
  }
}

type TrustMultiplierInput = TrustTierInput & Pick<Memory, "status">;

/**
 * Combined provenance score multiplier for retrieval ranking: trust tier
 * (#950, which subsumes the #949 assistant down-weight via the
 * `assistant_generated` tier) × disputed-status demotion.
 */
export function sourceTrustMultiplier(
  memory: TrustMultiplierInput,
  founderIds?: Set<string>,
): number {
  let multiplier = TRUST_TIER_MULTIPLIERS[deriveTrustTier(memory, founderIds)];
  if (memory.status === "disputed") multiplier *= DISPUTED_STATUS_MULTIPLIER;
  return multiplier;
}

// ── Capability-claim quarantine (#949) ───────────────────────────────────────

const AURA_SUBJECT_RE = /\baura(?:'s)?\b/i;

/** Capability nouns: access, tokens, credentials, permissions, scopes, keys. */
const CAPABILITY_NOUN_RE =
  /\b(access|token|credential(?:s)?|permission(?:s)?|scope(?:s)?|api[ -]?key(?:s)?|pat|oauth|secret(?:s)?|integration)\b/i;

/** Capability verb phrases: has/lacks/cannot/is unable/was granted/revoked… */
const CAPABILITY_VERB_RE =
  /\b(can(?:not|'t)|unable to|is not able to|does(?:n't| not) have|lacks?|no longer has|lost access|was (?:granted|revoked|denied)|has (?:no|read[- ]only|full|write|admin))\b/i;

/**
 * True when the memory content asserts something about Aura having or lacking
 * access to a system, tool, credential, or permission. Deliberately broad on
 * the capability side (any capability noun OR verb phrase counts) but anchored
 * on Aura being the subject — this only ever gates assistant-sourced memories
 * (see {@link isQuarantinedCapabilityClaim}), where over-matching errs toward
 * live re-verification, the safe direction.
 */
export function isCapabilityClaim(content: string): boolean {
  if (!AURA_SUBJECT_RE.test(content)) return false;
  return CAPABILITY_NOUN_RE.test(content) || CAPABILITY_VERB_RE.test(content);
}

/**
 * A capability claim about Aura sourced from Aura's OWN assistant message is
 * excluded from injection entirely (#949): access must be re-verified live,
 * not recalled from a possibly confabulated self-assertion. User- and
 * tool-sourced capability facts still surface normally.
 */
export function isQuarantinedCapabilityClaim(
  memory: Pick<Memory, "content" | "extractionSourceRole">,
): boolean {
  return (
    memory.extractionSourceRole === "assistant" && isCapabilityClaim(memory.content)
  );
}

// ── Correction-signal detection (#949) ───────────────────────────────────────

const CORRECTION_SIGNAL_RES: RegExp[] = [
  // "no, actually…" / "no — actually…"
  /\bno[,\s—–-]+actually\b/i,
  // "actually, it's / that's / it is…"
  /\bactually[,\s]+(?:it|that|this)(?:'s| is| was)\b/i,
  // "that's wrong / incorrect / not right / not true / not the case"
  /\b(?:that|this|it)(?:'s| is| was) (?:wrong|incorrect|not (?:right|correct|true|the case))\b/i,
  // "you're wrong / mistaken"
  /\byou(?:'re| are) (?:wrong|mistaken|incorrect)\b/i,
  // "you do have access…" / "you do actually have…"
  /\byou do (?:actually |in fact )?(?:have|has)\b/i,
  // "it's X, not Y" / "that was X, not Y"
  /\b(?:it|that|this)(?:'s| is| was) \w[^.,;!?]{0,40}?,? not \w/i,
  // "not X, it's Y"
  /\bnot \w[^.,;!?]{0,40}?[,;] (?:it|that)(?:'s| is)\b/i,
  // explicit "correction:" prefix
  /\bcorrection:?\b/i,
  // "…is no longer true / the case / correct"
  /\bno longer (?:true|the case|correct)\b/i,
];

/**
 * True when a user message explicitly contradicts a prior assertion.
 * Consumed by extraction: the corrected fact is written with
 * {@link CORRECTION_CONFIDENCE}, and semantically matching prior
 * assistant-sourced claims are marked `disputed` immediately (not left for
 * the daily consolidation sweep).
 */
export function detectCorrectionSignal(text: string): boolean {
  if (!text) return false;
  return CORRECTION_SIGNAL_RES.some((re) => re.test(text));
}
