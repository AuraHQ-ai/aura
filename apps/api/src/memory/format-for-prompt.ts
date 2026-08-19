import type { Memory } from "@aura/db/schema";
import { relativeTime } from "../lib/temporal.js";

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

  const formatted = memories
    .map((m) => {
      const created = new Date(m.createdAt);
      const timeAgo = relativeTime(created, now);
      // Pair the coarse relative phrase with the absolute date. `relativeTime`
      // floors to whole weeks/months past 7 days ("about 3 weeks ago"), which
      // destroys the day-level precision that duration questions ("how many
      // days ago…") need. The ISO date lets the reader compute exact elapsed
      // time; the relative phrase stays for natural phrasing.
      const on = Number.isNaN(created.getTime())
        ? ""
        : `${created.toISOString().slice(0, 10)}, `;
      const users =
        m.relatedUserIds.length > 0
          ? ` [about: ${m.relatedUserIds.join(", ")}]`
          : "";
      return `- [${m.type}] ${m.content} (${on}${timeAgo})${users}`;
    })
    .join("\n");

  return `These are things you've learned from previous interactions. Use them naturally if relevant -- don't force them in. Don't tell the user you're "checking your memories."\n\n${formatted}`;
}
