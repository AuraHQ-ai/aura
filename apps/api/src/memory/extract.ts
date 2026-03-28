import { generateText, Output } from "ai";
import { z } from "zod";
import { getFastModel } from "../lib/ai.js";
import { embedTexts } from "../lib/embeddings.js";
import { storeMemories, supersedeMemory, toDbChannelType, checkDuplicates } from "./store.js";
import { resolveEntities, linkMemoryEntities } from "./entity-resolution.js";
import { logger } from "../lib/logger.js";
import { getUserList } from "../tools/slack.js";
import type { NewMemory } from "@aura/db/schema";
import type { ChannelType } from "../pipeline/context.js";
import type { DbChannelType } from "./store.js";

// ── Injected Context Stripping ───────────────────────────────────────────────

const INJECTED_BLOCK_TAGS = [
  "memories",
  "related_threads",
  "notes_index",
  "context",
  "self_directive",
];

const INJECTED_BLOCK_RE = new RegExp(
  INJECTED_BLOCK_TAGS.map((tag) => `<${tag}>[\\s\\S]*?</${tag}>`).join("|"),
  "g",
);

/**
 * Strip XML blocks injected by the pipeline (memories, context, etc.)
 * from assistant messages before extraction to prevent echo loops.
 */
function stripInjectedContext(text: string): string {
  return text.replace(INJECTED_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

const MIN_STRIPPED_LENGTH = 50;

// ── User ID Normalization ───────────────────────────────────────────────────

const SLACK_USER_ID_RE = /^[UW][A-Z0-9]+$/;

/** Cached in-flight promise so concurrent callers share one API round-trip. */
let userLookupPromise: Promise<Map<string, string>> | null = null;

/**
 * Build a case-insensitive lookup from display names, real names, and
 * usernames to canonical Slack user IDs.  Unambiguous first-name lookups
 * are included as a convenience (the LLM often emits just "Joan").
 */
async function buildUserLookup(): Promise<Map<string, string>> {
  if (userLookupPromise) return userLookupPromise;
  userLookupPromise = buildUserLookupInner();
  return userLookupPromise;
}

async function buildUserLookupInner(): Promise<Map<string, string>> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    logger.warn("SLACK_BOT_TOKEN not set — skipping user ID normalization");
    return new Map();
  }

  try {
    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(botToken);

    const users = await getUserList(client);

    const lookup = new Map<string, string>();
    const firstNameUsers = new Map<string, Set<string>>();

    for (const u of users) {
      const names = [u.displayName, u.realName, u.username].filter(Boolean);

      for (const raw of names) {
        const lower = raw.toLowerCase().trim();
        if (!lower) continue;

        if (!lookup.has(lower)) lookup.set(lower, u.id);

        const underscored = lower.replace(/\s+/g, "_");
        if (underscored !== lower && !lookup.has(underscored)) {
          lookup.set(underscored, u.id);
        }

        const spaced = lower.replace(/_/g, " ");
        if (spaced !== lower && !lookup.has(spaced)) {
          lookup.set(spaced, u.id);
        }
      }

      for (const raw of [u.realName, u.displayName]) {
        if (!raw) continue;
        const first = raw.split(/\s+/)[0]?.toLowerCase().trim();
        if (!first) continue;
        let ids = firstNameUsers.get(first);
        if (!ids) { ids = new Set(); firstNameUsers.set(first, ids); }
        ids.add(u.id);
      }
    }

    for (const [firstName, ids] of firstNameUsers) {
      if (ids.size === 1 && !lookup.has(firstName)) {
        lookup.set(firstName, [...ids][0]);
      }
    }

    return lookup;
  } catch (error) {
    logger.warn("Failed to build user lookup — skipping user ID normalization", {
      error: String(error),
    });
    userLookupPromise = null;
    return new Map();
  }
}

/**
 * Normalize an array of user references (names, IDs, @-mentions) to
 * canonical Slack user IDs.  Unresolvable references are kept as-is.
 */
async function normalizeUserReferences(refs: string[]): Promise<string[]> {
  if (refs.length === 0) return refs;
  if (refs.every((r) => SLACK_USER_ID_RE.test(r))) return refs;

  const lookup = await buildUserLookup();
  if (lookup.size === 0) return refs;

  return refs.map((ref) => {
    if (SLACK_USER_ID_RE.test(ref)) return ref;

    // Strip Slack mention markup: <@U12345> → U12345
    const mentionMatch = ref.match(/^<@([UW][A-Z0-9]+)>$/);
    if (mentionMatch) return mentionMatch[1];

    const lower = ref.toLowerCase().trim().replace(/^@/, "");

    const direct = lookup.get(lower);
    if (direct) return direct;

    const withSpaces = lower.replace(/_/g, " ");
    if (withSpaces !== lower) {
      const spaced = lookup.get(withSpaces);
      if (spaced) return spaced;
    }

    const withUnderscores = lower.replace(/\s+/g, "_");
    if (withUnderscores !== lower) {
      const underscored = lookup.get(withUnderscores);
      if (underscored) return underscored;
    }

    logger.warn("Could not resolve user reference to Slack ID — keeping as-is", {
      userRef: ref,
    });
    return ref;
  });
}

/**
 * Schema for LLM-extracted memories.
 */
const extractedMemoriesSchema = z.object({
  memories: z.array(
    z.object({
      content: z
        .string()
        .describe("A concise statement of the memory, e.g. 'Joan prefers bullet points'"),
      type: z
        .enum(["fact", "decision", "personal", "preference", "relationship", "sentiment", "event", "open_thread", "insight"])
        .describe("The type of memory"),
      category: z
        .enum(["semantic", "episodic", "procedural"])
        .describe("semantic: durable facts/preferences/relationships. episodic: time-bound events/conversations/incidents. procedural: how-to knowledge/workflows.")
        .default("semantic"),
      utility: z
        .enum(["high", "medium", "low"])
        .describe("high: decisions, personal facts, business intelligence. medium: useful context. low: operational noise, status checks, agent actions — DISCARD these.")
        .default("medium"),
      relatedUserIds: z
        .array(z.string())
        .describe("Slack user IDs this memory is about"),
      shareable: z
        .boolean()
        .describe(
          "True only if the user explicitly asked Aura to share this info with someone specific",
        )
        .default(false),
      entities: z
        .array(
          z.object({
            name: z.string().describe("The entity name (full name for people, official name for companies)"),
            type: z
              .enum(["person", "company", "project", "product", "channel", "technology", "concept", "location"])
              .describe("The entity type"),
            role: z
              .enum(["subject", "object", "mentioned"])
              .describe("subject: who/what the memory is primarily about. object: secondary entity acted upon. mentioned: just referenced.")
              .default("mentioned"),
          }),
        )
        .optional()
        .default([])
        .describe("Entities (people, companies, projects, etc.) mentioned in this memory"),
    }),
  ),
});

/**
 * The extraction prompt — tells the LLM what to extract from a conversation exchange.
 */
const EXTRACTION_PROMPT = `You are a memory extraction system. Analyze the following conversation exchange and extract any meaningful memories worth retaining.

Extract ONLY things worth remembering long-term. Skip pleasantries, small talk, and things that aren't informative.

Types of memories to extract:
- **fact**: Concrete facts about work, projects, tools, or processes. E.g., "The Q3 launch date is March 15."
- **decision**: Decisions made by the team. E.g., "We decided to use Postgres instead of MongoDB."
- **personal**: Personal details about team members. E.g., "Tom has a dog named Biscuit."
- **preference**: User preferences and working style. E.g., "Joan prefers bullet points over prose."
- **relationship**: How people relate to each other. E.g., "Joan and Maria work closely on the mobile app."
- **sentiment**: Emotional context or opinions. E.g., "Joan seemed frustrated about the deploy process."
- **event**: Time-bound events or incidents. E.g., "Production went down on March 10 due to a migration bug."
- **open_thread**: Questions or tasks that were raised but not resolved. E.g., "Joan asked about the API docs but never got an answer."
- **insight**: Business intelligence or strategic observations. E.g., "Churn rate increased 15% after the pricing change."

Memory categories:
- **semantic**: Durable facts, preferences, relationships that remain true over time.
- **episodic**: Time-bound events, conversations, incidents tied to a specific moment.
- **procedural**: How-to knowledge, workflows, processes.

Utility assessment (IMPORTANT — be strict):
- **high**: Decisions, personal facts, business intelligence, preferences, relationship info.
- **medium**: Useful context that may be relevant later.
- **low**: Operational noise, status checks, agent actions, acknowledgments — these will be DISCARDED.

DO NOT extract memories about:
- Aura's own actions ("Aura checked the deploy", "Aura ran a query")
- Acknowledgments and pleasantries ("thanks", "got it", "sounds good")
- Scheduling logistics ("let's meet at 3pm") unless it's a decision
- Information that just restates what was already retrieved from memory in this conversation
- Meta-conversation about the memory system itself

Rules:
- Be concise — each memory should be one clear sentence.
- Include the person's name or Slack user ID when relevant.
- Don't extract things Aura already knows (if they're in the context).
- If the user explicitly asks Aura to tell someone something, mark that memory as shareable.
- Return an empty array if there's nothing worth remembering.

For each memory, also identify the entities (people, companies, projects, products, channels, technologies, concepts, locations) mentioned. Return them in the entities array with their name, type, and role:
- **subject**: the entity the memory is primarily about
- **object**: a secondary entity acted upon or referenced in relation to the subject
- **mentioned**: just referenced in passing
Use the most specific name you can identify (full name for people, official name for companies).`;

interface ExtractionContext {
  userMessage: string;
  assistantResponse: string;
  userId: string;
  channelType: ChannelType | DbChannelType;
  sourceMessageId?: string;
  displayName?: string;
  /** Role of the message that triggered extraction */
  triggerRole?: "user" | "assistant" | "tool";
}

/**
 * Extract memories from a conversation exchange.
 * Runs asynchronously via waitUntil — does not block the response.
 */
export async function extractMemories(context: ExtractionContext): Promise<void> {
  const start = Date.now();

  try {
    const strippedAssistant = stripInjectedContext(context.assistantResponse);
    const includeAssistant = strippedAssistant.length >= MIN_STRIPPED_LENGTH;

    const conversationText = includeAssistant
      ? `User (${context.displayName || context.userId}): ${context.userMessage}\n\nAura: ${strippedAssistant}`
      : `User (${context.displayName || context.userId}): ${context.userMessage}`;

    const extractionSourceRole = context.triggerRole ?? "user";

    const model = await getFastModel();

    const { output: object } = await generateText({
      model,
      output: Output.object({ schema: extractedMemoriesSchema }),
      system: EXTRACTION_PROMPT,
      prompt: conversationText,
    });

    if (!object || object.memories.length === 0) {
      logger.debug("No memories extracted from exchange");
      return;
    }

    // Filter out low-utility memories before embedding
    const filteredByUtility = object.memories.filter((m) => m.utility !== "low");
    const discardedLowUtility = object.memories.length - filteredByUtility.length;
    if (discardedLowUtility > 0) {
      logger.info(`Filtered out ${discardedLowUtility} low-utility memories`);
    }
    if (filteredByUtility.length === 0) {
      logger.debug("All extracted memories were low utility — nothing to store");
      return;
    }

    // Normalize user references to canonical Slack user IDs
    const normalizedMemories = await Promise.all(
      filteredByUtility.map(async (m) => ({
        ...m,
        relatedUserIds: await normalizeUserReferences(m.relatedUserIds),
      })),
    );

    // Embed all extracted memories in a single batch
    const memoryTexts = normalizedMemories.map((m) => m.content);
    let embeddings: (number[] | null)[];
    try {
      embeddings = await embedTexts(memoryTexts);
    } catch (embedError) {
      logger.error("Memory embedding failed — storing memories WITHOUT embeddings", {
        error: String(embedError),
        memoryCount: memoryTexts.length,
        userId: context.userId,
      });
      embeddings = memoryTexts.map(() => null);
    }

    // Resolve workspace consistently for both memories and entities
    const workspaceId = process.env.DEFAULT_WORKSPACE_ID || "default";

    // Dedup check: skip memories that are near-duplicates of existing ones
    const dedupResults = await checkDuplicates(
      normalizedMemories.map((m, i) => ({ content: m.content, embedding: embeddings[i] ?? null })),
      workspaceId,
    );

    const dedupSkipped = dedupResults.filter((r) => r.dominated).length;
    const dedupSuperseded = dedupResults.filter((r) => r.supersedesId).length;
    if (dedupSkipped > 0 || dedupSuperseded > 0) {
      logger.info("Memory dedup results", {
        memories_skipped_dedup: dedupSkipped,
        memories_superseded: dedupSuperseded,
      });
    }

    // Build final list excluding dominated duplicates
    const survivingIndices = dedupResults
      .map((r, i) => (r.dominated ? -1 : i))
      .filter((i) => i >= 0);

    if (survivingIndices.length === 0) {
      logger.debug("All extracted memories were duplicates — nothing to store");
      return;
    }

    // Prepare memories for storage
    const newMemories: NewMemory[] = survivingIndices.map((i) => ({
      content: normalizedMemories[i].content,
      type: normalizedMemories[i].type,
      category: normalizedMemories[i].category,
      workspaceId,
      sourceMessageId: context.sourceMessageId || undefined,
      sourceChannelType: toDbChannelType(context.channelType),
      relatedUserIds: normalizedMemories[i].relatedUserIds.length > 0
        ? normalizedMemories[i].relatedUserIds
        : [context.userId],
      embedding: embeddings[i] ?? null,
      shareable: normalizedMemories[i].shareable ? 1 : 0,
      relevanceScore: 1.0,
      extractionSourceRole,
    }));

    const hasEmbeddings = newMemories.some((m) => m.embedding !== null);
    const memoryIds = await storeMemories(newMemories);

    // Properly supersede old memories with lifecycle transitions
    // Map surviving indices back to their dedup results to pair old→new memory IDs
    for (let j = 0; j < survivingIndices.length; j++) {
      const i = survivingIndices[j];
      const oldId = dedupResults[i].supersedesId;
      const newId = memoryIds[j];
      if (oldId && newId) {
        await supersedeMemory(oldId, newId);
      }
    }

    // Resolve entities and link them to memories (best-effort, don't block)
    for (let j = 0; j < survivingIndices.length; j++) {
      const i = survivingIndices[j];
      const extractedEntities = normalizedMemories[i].entities;
      if (extractedEntities && extractedEntities.length > 0 && memoryIds[j]) {
        try {
          const resolved = await resolveEntities(extractedEntities, workspaceId);
          await linkMemoryEntities(memoryIds[j], resolved);
        } catch (entityError) {
          logger.warn("Entity resolution failed for memory, skipping", {
            memoryId: memoryIds[j],
            error: String(entityError),
          });
        }
      }
    }

    logger.info(`Extracted ${newMemories.length} memories in ${Date.now() - start}ms`, {
      types: newMemories.map((m) => m.type),
      hasEmbeddings,
      discardedLowUtility,
      dedupSkipped,
    });
  } catch (error) {
    logger.error("Memory extraction failed", {
      error: String(error),
      stack: (error as Error).stack?.split("\n").slice(0, 5).join(" | "),
      userId: context.userId,
    });
    // Don't rethrow — extraction is best-effort and should not crash the pipeline
  }
}
