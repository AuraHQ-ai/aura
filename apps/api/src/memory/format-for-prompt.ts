import type { Memory } from "@aura/db/schema";
import { relativeTime } from "../lib/temporal.js";
import { needsVerifyBeforeAsserting } from "./fact-class.js";

/**
 * Pick the instant to render next to a memory.
 *
 * `valid_from` is event time when the extractor populated it from a stated
 * calendar date; `createdAt` is ingestion/session time. Prefer valid_from
 * when the two differ by a calendar day or more so "how many months ago did
 * I book…" is counted off the booking, not the mention. Same-day (or missing)
 * valid_from keeps createdAt — that's the session-time default.
 */
export function memoryDisplayDate(memory: Pick<Memory, "createdAt" | "validFrom">): Date {
  const created = new Date(memory.createdAt);
  const createdOk = !Number.isNaN(created.getTime());
  if (memory.validFrom == null) return created;
  const from = new Date(memory.validFrom);
  if (Number.isNaN(from.getTime())) return created;
  if (!createdOk) return from;
  if (from.toISOString().slice(0, 10) !== created.toISOString().slice(0, 10)) return from;
  return created;
}

/**
 * Format retrieved memories for LLM injection.
 *
 * Shared between the production prompt builder (apps/api/src/personality/
 * system-prompt.ts) and the memory benchmark harness (apps/api/bench/src/
 * eval-qa.ts) so the bench scores reflect the same wire format the agent
 * actually sees in production. Touching this file shifts both at once,
 * which is the desired property.
 *
 * `now` anchors the relative-time rendering ("3 months ago"). Production
 * leaves it undefined → wall-clock now. The bench passes the question's
 * reference date so temporal-reasoning answers are computed against the same
 * "now" the gold answer assumes, instead of the real (2026) clock.
 */
export function formatMemoriesForPrompt(memories: Memory[], now?: Date): string {
  if (memories.length === 0) return "";

  const reference = now ?? new Date();
  const formatted = memories
    .map((m) => {
      const anchor = memoryDisplayDate(m);
      const iso = Number.isNaN(anchor.getTime()) ? "" : anchor.toISOString().slice(0, 10);
      // Pair the coarse relative phrase with the absolute date. `relativeTime`
      // floors to whole weeks/months past 7 days ("about 3 weeks ago"), which
      // destroys the day-level precision that duration questions ("how many
      // days ago…") need. The ISO date lets the reader compute exact elapsed
      // time; the relative phrase stays for natural phrasing.
      // If the anchor sits after `now` (later session still in the as-of
      // window, clock skew), omit the relative phrase entirely — never render
      // "in the future" for a past fact. The ISO date is enough.
      const parts: string[] = [];
      if (iso) parts.push(iso);
      if (!Number.isNaN(anchor.getTime()) && anchor.getTime() <= reference.getTime()) {
        parts.push(relativeTime(anchor, reference));
      }
      const when = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      const users = m.relatedUserIds.length > 0 ? ` [about: ${m.relatedUserIds.join(", ")}]` : "";
      // Volatile classes (access, permissions, pricing, URLs, tool status)
      // go stale without an explicit correction — tell the model to verify
      // before asserting them as current (#1557).
      const verify = needsVerifyBeforeAsserting(m.factClass)
        ? ` [verify before asserting: ${m.factClass}]`
        : "";
      return `- [${m.type}] ${m.content} ${when}${users}${verify}`;
    })
    .join("\n");

  return `These are things you've learned from previous interactions. Use them naturally if relevant -- don't force them in. Don't tell the user you're "checking your memories."\n\n${formatted}`;
}
