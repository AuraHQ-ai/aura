import { tool } from "ai";
import { z } from "zod";

// In-memory scratchpad store, scoped per invocation.
// Key: invocation ID, Value: Map of section name → content string.
const scratchpads = new Map<string, Map<string, string>>();

export function createScratchpadTools(invocationId: string) {
  if (!scratchpads.has(invocationId)) {
    scratchpads.set(invocationId, new Map());
  }
  const pad = scratchpads.get(invocationId)!;

  const scratchpad_write = tool({
    description:
      "Write or update a section in the working scratchpad. Use this during long-running jobs to save intermediate results, running tallies, or key findings that you'll need later. Each section is identified by a key. Writing to an existing key overwrites it. The scratchpad persists for the duration of this invocation only.",
    inputSchema: z.object({
      key: z
        .string()
        .describe(
          "Section name, e.g. 'findings', 'running-total', 'channels-checked'",
        ),
      content: z
        .string()
        .describe(
          "Content to write. Supports markdown. Keep it concise — this is working memory, not a document.",
        ),
    }),
    execute: async ({ key, content }) => {
      pad.set(key, content);
      const keys = Array.from(pad.keys());
      return `Written to scratchpad section "${key}". Current sections: ${keys.join(", ")}`;
    },
  });

  const scratchpad_read = tool({
    description:
      "Read the current scratchpad contents. Returns all sections if no key specified, or a specific section by key. Use this to recall your intermediate findings during long-running jobs instead of re-reading tool results from many steps ago.",
    inputSchema: z.object({
      key: z
        .string()
        .optional()
        .describe("Specific section to read. Omit to read all sections."),
    }),
    execute: async ({ key }) => {
      if (key) {
        const content = pad.get(key);
        return (
          content ??
          `Section "${key}" not found. Available sections: ${Array.from(pad.keys()).join(", ")}`
        );
      }
      if (pad.size === 0) return "Scratchpad is empty.";
      const sections = Array.from(pad.entries())
        .map(([k, v]) => `## ${k}\n${v}`)
        .join("\n\n");
      return `Scratchpad (${pad.size} sections):\n\n${sections}`;
    },
  });

  return { scratchpad_write, scratchpad_read };
}

/** Retrieve scratchpad contents for persistence at end of invocation. */
export function getScratchpadContents(
  invocationId: string,
): Record<string, string> | null {
  const pad = scratchpads.get(invocationId);
  if (!pad || pad.size === 0) return null;
  return Object.fromEntries(pad);
}

/** Clean up scratchpad after invocation ends to prevent memory leaks. */
export function cleanupScratchpad(invocationId: string): void {
  scratchpads.delete(invocationId);
}
