import { z } from "zod";

/**
 * Shared schema and prompt for entity extraction, used by both:
 * - The live pipeline (extract.ts)
 * - The backfill script (backfill-entities.ts)
 */

export const ENTITY_TYPES = [
  "person",
  "company",
  "project",
  "product",
  "channel",
  "technology",
  "concept",
  "location",
] as const;

export const ENTITY_ROLES = ["subject", "object", "mentioned"] as const;

/**
 * Schema for a single extracted entity with aliases.
 */
export const extractedEntitySchema = z.object({
  name: z
    .string()
    .describe("The entity name (full name for people, official name for companies)"),
  type: z
    .enum(ENTITY_TYPES)
    .describe("The entity type"),
  role: z
    .enum(ENTITY_ROLES)
    .describe(
      "subject: who/what the memory is primarily about. object: secondary entity acted upon. mentioned: just referenced.",
    )
    .default("mentioned"),
  aliases: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      'Alternative names for THE SAME entity (not related or similar entities). E.g. "Joan Rodriguez" → ["Joan", "@joan", "joanrodriguez"]. PR #200 and PR #201 are DIFFERENT entities, not aliases. Only include nicknames, abbreviations, and short forms that refer to the exact same thing.',
    ),
});

export type ExtractedEntity = z.infer<typeof extractedEntitySchema>;

/**
 * Entity extraction guidance appended to any prompt that extracts entities.
 * Covers typing rules and exclusion rules shared across backfill and live extraction.
 */
export const ENTITY_EXTRACTION_RULES = `
Entity types: person, company, project, product, channel, technology, concept, location

For each entity, also return aliases — alternative names for THE EXACT SAME entity:
- Aliases must refer to the same thing. "PR #200" and "PR #201" are DIFFERENT entities — never list one as an alias of the other.
- For people: first name, username, @-mention handle, name without spaces. E.g. "Joan Rodriguez" → ["Joan", "@joan", "joanrodriguez"]
- For companies: abbreviations, stock tickers, common short forms. E.g. "RealAdvisor" → ["RA"]
- For technologies: common abbreviations. E.g. "PostgreSQL" → ["Postgres", "PG"]
- For others: any short form or alternative reference used in conversation that means the same thing.
- Never output aliases that are just linguistic particles or stopwords (e.g. "de", "da", "del", "la", "le", "van", "von").
- Avoid 1-2 character aliases unless they are established acronyms/tickers/handles (e.g. "RA", "@jd").

Typing rules:
- Slack channel names (e.g. #bugs, #general) are type "channel"
- npm packages, libraries, frameworks, programming languages are type "technology"
- Do not classify abstract concepts, metric labels, or KPI names as person entities
- For person entities, prefer full names. Avoid creating a new person from a standalone first name unless the context uniquely identifies that exact person.

DO NOT extract as entities:
- Metric names, KPI labels, or analytics segments (e.g. "90-day active users", "2nd-year churners", "MRR", "churn rate")
- Generic role descriptions without a specific name (e.g. "the team", "engineering", "users")
- Abstract concepts that are not named things (e.g. "performance", "scalability")

Roles:
- subject: who/what the memory is primarily about
- object: secondary entity acted upon or referenced in relation to the subject
- mentioned: just referenced in passing`;
