/**
 * Windowing for the eval funnel judge.
 *
 * The thread is a BAD scoring unit (it can run hundreds of messages and pivot
 * topic many times) and a "group by time+topic" segmenter is just another
 * machine with its own error rate. So we do NOT segment: the scoring unit is
 * the atomic response and the context unit is a dumb sliding window.
 *
 * Windowing stays dumb: slide an N-turn window with a few turns of overlap so a
 * response near a boundary still sees its antecedent (leading context) and its
 * resolution (trailing context, for `resolved_in_window`). No topic logic.
 *
 * Ownership is EXCLUSIVE: each scorable candidate turn is owned by exactly one
 * window (so it's judged once), even though the context slices overlap.
 */

import type { ConversationTurn, JudgeWindow } from "./types.js";

export interface WindowOptions {
  /** Turns committed (owned) per window step. */
  stride?: number;
  /** Leading context turns prepended to each window slice. */
  lead?: number;
  /** Trailing context turns appended to each window slice. */
  trail?: number;
}

/** A response is a scoring candidate iff it's an assistant turn with text. */
export function isScoringCandidate(turn: ConversationTurn): boolean {
  return turn.role === "assistant" && turn.textPartId != null;
}

/**
 * Split a chronological turn list into overlapping windows. Each window's
 * `ownedPartIds` are the candidate turns (assistant-with-text, not yet scored)
 * that fall in this window's exclusive commit region. The full `context` slice
 * adds `lead` turns before and `trail` turns after so boundary responses still
 * see their antecedent and resolution.
 *
 * Default lead/stride/trail (3/14/3) keeps the visible slice ≈ the 20-turn
 * Sonnet batch described in the spec.
 */
export function buildWindows(
  turns: ConversationTurn[],
  opts: WindowOptions = {},
): JudgeWindow[] {
  const stride = Math.max(1, opts.stride ?? 14);
  const lead = Math.max(0, opts.lead ?? 3);
  const trail = Math.max(0, opts.trail ?? 3);

  const windows: JudgeWindow[] = [];

  for (let start = 0; start < turns.length; start += stride) {
    const commitEnd = Math.min(turns.length, start + stride);

    // Exclusive ownership: candidates in [start, commitEnd) that still need a
    // verdict. A turn already scored in a prior run is skipped (idempotent).
    const ownedPartIds: string[] = [];
    for (let i = start; i < commitEnd; i++) {
      const turn = turns[i];
      if (isScoringCandidate(turn) && !turn.alreadyScored && turn.textPartId) {
        ownedPartIds.push(turn.textPartId);
      }
    }

    if (ownedPartIds.length === 0) continue;

    const sliceStart = Math.max(0, start - lead);
    const sliceEnd = Math.min(turns.length, commitEnd + trail);
    windows.push({
      context: turns.slice(sliceStart, sliceEnd),
      ownedPartIds,
    });
  }

  return windows;
}
