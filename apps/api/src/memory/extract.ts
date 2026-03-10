import { generateText, Output } from "ai";
import { z } from "zod";
import { getFastModel } from "../lib/ai.js";
import { embedTexts } from "../lib/embeddings.js";
import { storeMemories, toDbChannelType } from "./store.js";
import { logger } from "../lib/logger.js";
import { getUserList } from "../tools/slack.js";
import type { NewMemory } from "@aura/db/schema";
import type { ChannelType } from "../pipeline/context.js";

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
        .enum(["fact", "decision", "personal", "relationship", "sentiment", "open_thread"])
        .describe("The type of memory"),
      relatedUserIds: z
        .array(z.string())
        .describe("Slack user IDs this memory is about"),
      shareable: z
        .boolean()
        .describe(
          "True only if the user explicitly asked Aura to share this info with someone specific",
        )
        .default(false),
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
- **relationship**: How people relate to each other. E.g., "Joan and Maria work closely on the mobile app."
- **sentiment**: Emotional context or opinions. E.g., "Joan seemed frustrated about the deploy process."
- **open_thread**: Questions or tasks that were raised but not resolved. E.g., "Joan asked about the API docs but never got an answer."

Rules:
- Be concise — each memory should be one clear sentence.
- Include the person's name or Slack user ID when relevant.
- Don't extract things Aura already knows (if they're in the context).
- If the user explicitly asks Aura to tell someone something, mark that memory as shareable.
- Return an empty array if there's nothing worth remembering.`;

interface ExtractionContext {
  userMessage: string;
  assistantResponse: string;
  userId: string;
  channelType: ChannelType;
  sourceMessageId?: string;
  displayName?: string;
}

/**
 * Extract memories from a conversation exchange.
 * Runs asynchronously via waitUntil — does not block the response.
 */
export async function extractMemories(context: ExtractionContext): Promise<void> {
  const start = Date.now();

  try {
    const conversationText = `User (${context.displayName || context.userId}): ${context.userMessage}\n\nAura: ${context.assistantResponse}`;

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

    // Normalize user references to canonical Slack user IDs
    const normalizedMemories = await Promise.all(
      object.memories.map(async (m) => ({
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

    // Prepare memories for storage
    const newMemories: NewMemory[] = normalizedMemories.map((m, i) => ({
      content: m.content,
      type: m.type,
      sourceMessageId: context.sourceMessageId || undefined,
      sourceChannelType: toDbChannelType(context.channelType),
      relatedUserIds: m.relatedUserIds.length > 0 ? m.relatedUserIds : [context.userId],
      embedding: embeddings[i] ?? null,
      shareable: m.shareable ? 1 : 0,
      relevanceScore: 1.0,
    }));

    const hasEmbeddings = newMemories.some((m) => m.embedding !== null);
    await storeMemories(newMemories);

    logger.info(`Extracted ${newMemories.length} memories in ${Date.now() - start}ms`, {
      types: newMemories.map((m) => m.type),
      hasEmbeddings,
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
