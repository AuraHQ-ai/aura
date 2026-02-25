/**
 * Skill index builder for progressive disclosure.
 *
 * Queries all skill notes and formats a compact index (topic + first line)
 * for injection into system prompts. ~20 tokens per skill.
 *
 * Inspired by OpenClaw's three-level progressive disclosure:
 * - Level 1 (always loaded): topic + first line in the system prompt
 * - Level 2 (on demand): full skill note content via read_note
 * - Level 3 (lazy): referenced resources executed when needed
 */

import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes } from "../db/schema.js";

/**
 * Build a compact skill index for injection into system prompts.
 * Returns empty string if no skill notes exist.
 *
 * Ordered by topic to ensure deterministic output — PostgreSQL returns rows
 * in arbitrary order without ORDER BY, which would bust the prompt cache.
 */
export async function buildSkillIndex(): Promise<string> {
  const skills = await db
    .select({ topic: notes.topic, content: notes.content })
    .from(notes)
    .where(eq(notes.category, "skill"))
    .orderBy(asc(notes.topic));

  if (skills.length === 0) return "";

  const index = skills
    .map((s) => {
      const firstLine =
        s.content
          .split("\n")
          .find((l) => l.trim() && !l.startsWith("#")) || "";
      return `- ${s.topic}: ${firstLine.substring(0, 80)}`;
    })
    .join("\n");

  return `\n## Your skill notes\n\nYou have playbooks for complex tasks. Use read_note to load the full skill before starting.\n\n${index}`;
}
