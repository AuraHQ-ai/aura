import type { Memory } from "@aura/db/schema";
import { relativeTime } from "../lib/temporal.js";

/**
 * Format retrieved memories for LLM injection (production prompt + benchmarks).
 */
export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) return "";

  const formatted = memories
    .map((m) => {
      const timeAgo = relativeTime(new Date(m.createdAt));
      const users =
        m.relatedUserIds.length > 0
          ? ` [about: ${m.relatedUserIds.join(", ")}]`
          : "";
      return `- [${m.type}] ${m.content} (${timeAgo})${users}`;
    })
    .join("\n");

  return `These are things you've learned from previous interactions. Use them naturally if relevant — don't force them in.\n\n${formatted}`;
}
