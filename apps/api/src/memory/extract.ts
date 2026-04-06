import { generateText, generateObject, Output } from "ai";
import { z } from "zod";
import { getFastModel } from "../lib/ai.js";
import { embedText, embedTexts } from "../lib/embeddings.js";
import {
  storeMemories, supersedeMemory, toDbChannelType, checkDuplicates,
  fetchThreadMessages, updateMemoryContent, archiveMemory,
  findContradictionCandidates,
} from "./store.js";
import { retrieveMemories } from "./retrieve.js";
import { resolveEntities, linkMemoryEntities } from "./entity-resolution.js";
import { logger } from "../lib/logger.js";
import { getUserList } from "../tools/slack.js";
import {
  extractedEntitySchema,
  ENTITY_EXTRACTION_RULES,
} from "./entity-extraction-schema.js";
import { importanceToRelevance, IMPORTANCE_DISCARD_THRESHOLD } from "./importance.js";
import { db } from "../db/client.js";
import { users, memoryEntities } from "@aura/db/schema";
import { inArray, eq } from "drizzle-orm";
import type { NewMemory, Memory } from "@aura/db/schema";
import type { ChannelType } from "../pipeline/context.js";
import type { DbChannelType } from "./store.js";
import type { ThreadMessage } from "./store.js";

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

// ── Thread Context Building ─────────────────────────────────────────────────

const MAX_THREAD_CONTEXT_CHARS = 4000;
const MAX_MSG_CHARS = 500;

const TOOL_STATUS_RE = /^\[([^\]]+)\]\s*\((OK|ERROR)\)/;

/**
 * Build a compact thread representation with aggressive tool-message pruning.
 * Tool messages are reduced to just "[Tool: name] OK/ERROR" (no I/O).
 * User/assistant messages are truncated to MAX_MSG_CHARS.
 */
function buildThreadContext(
  threadMessages: ThreadMessage[],
  displayNames: Map<string, string>,
): string {
  const lines: string[] = [];
  let totalLen = 0;

  // Iterate newest-first so the most recent (and most relevant) messages are
  // always included, then reverse to restore chronological order.
  for (let i = threadMessages.length - 1; i >= 0; i--) {
    const msg = threadMessages[i];
    let line: string;
    if (msg.role === "tool") {
      const match = msg.content.match(TOOL_STATUS_RE);
      line = match ? `[Tool: ${match[1]}] ${match[2]}` : "[Tool]";
    } else if (msg.role === "assistant") {
      const stripped = stripInjectedContext(msg.content);
      const truncated = stripped.length > MAX_MSG_CHARS
        ? stripped.slice(0, MAX_MSG_CHARS) + "..."
        : stripped;
      line = `[Aura]: ${truncated}`;
    } else {
      const name = displayNames.get(msg.userId) || msg.userId;
      const truncated = msg.content.length > MAX_MSG_CHARS
        ? msg.content.slice(0, MAX_MSG_CHARS) + "..."
        : msg.content;
      line = `[User (${name})]: ${truncated}`;
    }

    if (totalLen + line.length + 1 > MAX_THREAD_CONTEXT_CHARS) break;
    lines.push(line);
    totalLen += line.length + 1;
  }

  lines.reverse();
  return lines.join("\n");
}

/**
 * Format existing memories as a numbered reference list for the LLM.
 * Returns the formatted string and a map of ref IDs (M1, M2...) to real DB IDs.
 */
function formatExistingMemories(
  existingMemories: Memory[],
): { formatted: string; refToId: Map<string, string> } {
  const refToId = new Map<string, string>();
  if (existingMemories.length === 0) {
    return { formatted: "No existing memories found for this context.", refToId };
  }
  const lines = existingMemories.map((m, i) => {
    const ref = `M${i + 1}`;
    refToId.set(ref, m.id);
    return `[${ref}] ${m.content} (type: ${m.type}, importance: ${m.importance ?? "?"})`;
  });
  return { formatted: lines.join("\n"), refToId };
}

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
        .enum(["fact", "decision", "preference", "event", "open_thread"])
        .describe("fact: durable info about people/org/world (subsumes personal, relationships). decision: explicit choices with participants. preference: how someone wants things done. event: something that happened at a specific time. open_thread: unresolved work/pending questions."),
      category: z
        .enum(["semantic", "episodic", "procedural"])
        .describe("semantic: durable facts/preferences/relationships. episodic: time-bound events/conversations/incidents. procedural: how-to knowledge/workflows.")
        .default("semantic"),
      importance: z
        .number()
        .int()
        .min(1)
        .max(100)
        .describe("How important is this memory to recall months from now? 1-100. 90-100: business decisions, org changes, key relationships. 70-89: product discussions, bugs with impact, personal facts. 40-69: status updates with substance, meeting notes. 20-39: routine coordination, minor updates. 1-19: operational noise, 'ok thanks', agent self-actions.")
        .default(50),
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
        .array(extractedEntitySchema)
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

## Memory Types (5 types -- use these precisely)

- **fact**: Durable information about people, the org, or the world. This includes personal details, relationships, roles, titles, team structure, and business context. E.g., "Joan manages the Aura codebase", "Tom has a dog named Biscuit", "Joan and Maria work closely on the mobile app", "Churn rate increased 15% after the pricing change."
- **decision**: Explicit choices made, with who made them. E.g., "We decided to use Postgres instead of MongoDB."
- **preference**: How someone wants things done. Communication style, tool choices, formatting preferences. E.g., "Joan prefers bullet points over prose."
- **event**: Something that happened at a specific time. Incidents, launches, meetings with outcomes. E.g., "Production went down on March 10 due to a migration bug."
- **open_thread**: Unresolved work, pending questions, things someone said they'd do. These should eventually be resolved. E.g., "Joan asked about the API docs but never got an answer."

## Memory Categories (3 categories -- orthogonal to type)

- **semantic**: Durable facts, preferences, relationships that remain true over time.
- **episodic**: Time-bound events, conversations, incidents tied to a specific moment.
- **procedural**: How-to knowledge, workflows, processes, patterns of behavior.

## Admission Rules

Save things that would be EXPENSIVE TO REDISCOVER. Unlike a coding agent that can grep the codebase instantly, this agent's retrieval relies on stored memories and whatever is in the conversation context. If finding this fact again would require searching Slack channels, reading email threads, querying databases, or exploring codebases -- store it now. The memory is a cache that saves future tool calls.

DO NOT save:
- Things already in the agent's persistent notes or self-directive (those are always in context)
- Exact duplicates of things already stored as memories
- Transient noise that won't matter in 48 hours
- Aura's own actions ("Aura checked the deploy", "Aura ran a query")
- Acknowledgments and pleasantries ("thanks", "got it", "sounds good")
- Scheduling logistics ("let's meet at 3pm") unless it's a decision
- Information that just restates what was already retrieved from memory in this conversation
- Meta-conversation about the memory system itself

## Importance Scoring (be strict, use the 1-100 scale)

- **90-100**: Company-level decisions, strategy pivots, OKRs/KPIs that drive planning, critical rules/policies, major incidents with lasting impact.
- **70-89**: Important technical/product decisions, high-impact customer or org context, durable people/ownership facts, non-trivial constraints.
- **40-69**: Useful but replaceable context (project updates, meeting outcomes, tactical plans, substantial status).
- **20-39**: Routine coordination, recurring operational updates, minor progress check-ins.
- **1-19**: Operational noise, status checks, agent actions, acknowledgments -- these will be DISCARDED.

Aggressive scoring guidance:
- Default conservative: if unsure, score LOWER.
- Routine sales motion chatter (new offer, pricing discussion, pipeline activity, "need more sales", generic MRR/revenue commentary) should usually be 20-45 unless it contains an explicit strategic decision, policy, or durable commitment.
- Generic quarter references ("Q1 was strong", "Q2 is hard") without a concrete decision or lasting constraint should be <=40.
- Explicit OKRs, strategy choices, hard rules, governance decisions, and durable operating principles should be >=75, and often >=85 when they affect planning/execution across teams.

## Rules

- Be concise -- each memory should be one clear sentence.
- ALWAYS use the person's real name in memory content (e.g. "Joan Rodriguez prefers..."), NEVER raw Slack user IDs. The context provides display names — use them.
- Don't extract things Aura already knows (if they're in the context).
- If the user explicitly asks Aura to tell someone something, mark that memory as shareable.
- Return an empty array if there's nothing worth remembering.

For each memory, also identify the entities mentioned. Return them in the entities array with their name, type, role, and aliases.
Use the most specific name you can identify (full name for people, official name for companies).

${ENTITY_EXTRACTION_RULES}`;

// ── Thread-Scoped Reconciliation ─────────────────────────────────────────────

const memoryTypeValues = ["fact", "decision", "preference", "event", "open_thread"] as const;

const createOperationSchema = z.object({
  action: z.literal("create"),
  content: z.string().describe("A concise statement of the memory"),
  type: z.enum(memoryTypeValues).describe("The type of memory"),
  category: z.enum(["semantic", "episodic", "procedural"]).default("semantic"),
  importance: z.number().int().min(1).max(100).default(50),
  relatedUserIds: z.array(z.string()).describe("Slack user IDs this memory is about"),
  shareable: z.boolean().default(false),
  entities: z.array(extractedEntitySchema).optional().default([]),
});

const updateOperationSchema = z.object({
  action: z.literal("update"),
  memoryRef: z.string().describe("Reference ID from existing memories, e.g. M1, M2"),
  content: z.string().describe("Updated content for this memory"),
  importance: z.number().int().min(1).max(100).optional(),
  entities: z.array(extractedEntitySchema).optional().default([]),
});

const deleteOperationSchema = z.object({
  action: z.literal("delete"),
  memoryRef: z.string().describe("Reference ID from existing memories, e.g. M1, M2"),
  reason: z.string().describe("Brief reason why this memory should be removed"),
});

const reconciliationSchema = z.object({
  operations: z.array(z.discriminatedUnion("action", [
    createOperationSchema,
    updateOperationSchema,
    deleteOperationSchema,
  ])),
});

const RECONCILIATION_PROMPT = `You are a memory reconciliation system. You analyze conversation threads and existing memories to produce precise operations: create new, update existing, or delete outdated memories.

## Existing Memories
These are the relevant memories already stored. Reference them by their ID (M1, M2, etc.):

{existingMemories}

## Instructions

Given the conversation thread below, decide what memory operations are needed:

- **create**: Genuinely NEW information not captured in any existing memory above. Do NOT create a memory if an existing one already covers the same fact, even with different wording.
- **update**: An existing memory whose content should be refined, corrected, or expanded based on new information in the thread. Prefer UPDATE over CREATE+DELETE when refining. Reference the memory by its ID (e.g. M1).
- **delete**: An existing memory that is now known to be wrong, obsolete, or superseded by events in the thread. Reference by ID and provide a reason.
- If nothing meaningful is new, return an empty operations array.

## What to extract

Types of memories:
- **fact**: Durable information about people, the org, or the world. Includes personal details, relationships, roles, titles, team structure, and business context.
- **decision**: Explicit choices made by the team with participants.
- **preference**: How someone wants things done — working style, tool choices, communication preferences.
- **event**: Time-bound events or incidents that happened at a specific time.
- **open_thread**: Questions or tasks raised but not yet resolved.

Categories: semantic (durable facts), episodic (time-bound events), procedural (how-to knowledge).

Importance (be strict):
- 90-100: company-level decisions, strategy pivots, OKRs/KPIs that drive planning, critical rules/policies, major incidents.
- 70-89: important technical/product decisions, high-impact org/customer context, durable people facts.
- 40-69: useful but replaceable tactical updates and meeting outcomes.
- 20-39: routine operational updates and minor coordination.
- 1-19: noise (will be DISCARDED).

Aggressive scoring guidance:
- Default conservative: if unsure, score LOWER.
- Routine sales motion chatter (new offer, pricing discussion, pipeline activity, generic MRR/revenue commentary) should usually be 20-45 unless there is an explicit strategic decision or durable constraint.
- Generic quarter references ("Q1 was strong", "Q2 is hard") without explicit decisions should be <=40.
- OKRs, strategy, and important operating rules should score >=75 (often >=85 if broadly impactful).

## What NOT to extract
- Aura's own actions ("Aura ran a query", "Aura checked the deploy")
- Pleasantries and acknowledgments ("thanks", "got it")
- Information already captured in existing memories above (the whole point is to AVOID duplicates)
- Meta-conversation about the memory system itself
- Scheduling logistics unless they represent a decision

## Rules
- Be concise — one clear sentence per memory.
- ALWAYS use the person's real name in memory content (e.g. "Joan Rodriguez prefers..."), NEVER raw Slack user IDs (e.g. "U0678NQJ2 prefers..."). The thread context shows names — use them.
- Only mark shareable=true if the user explicitly asked Aura to tell someone something.
- For create and update operations, include entity extraction that matches the final memory content.

${ENTITY_EXTRACTION_RULES}`;

interface ExtractionContext {
  userMessage: string;
  assistantResponse: string;
  userId: string;
  channelType: ChannelType | DbChannelType;
  sourceMessageId?: string;
  displayName?: string;
  /** Role of the message that triggered extraction */
  triggerRole?: "user" | "assistant" | "tool";
  /** Channel ID — enables thread-scoped extraction when paired with threadTs */
  channelId?: string;
  /** Thread timestamp — enables thread-scoped extraction when paired with channelId */
  threadTs?: string;
  /** Override createdAt on stored memories (for backfills) */
  createdAt?: Date;
}

/**
 * Extract memories from a conversation exchange.
 * Runs asynchronously via waitUntil — does not block the response.
 *
 * When channelId + threadTs are provided, uses thread-scoped reconciliation:
 * fetches full thread history and existing memories, then produces
 * CREATE/UPDATE/DELETE operations. Falls back to single-exchange extraction
 * when thread context is unavailable.
 */
type ExtractionSourceRole = "user" | "assistant" | "tool";

export async function extractMemories(context: ExtractionContext): Promise<void> {
  const start = Date.now();
  const workspaceId = process.env.DEFAULT_WORKSPACE_ID || "default";
  const extractionSourceRole: ExtractionSourceRole = context.triggerRole ?? "user";

  try {
    const useReconciliation = !!(context.channelId && context.threadTs);

    if (useReconciliation) {
      await extractWithReconciliation(context, workspaceId, extractionSourceRole, start);
    } else {
      await extractSingleExchange(context, workspaceId, extractionSourceRole, start);
    }
  } catch (error) {
    logger.error("Memory extraction failed", {
      error: String(error).slice(0, 200),
      userId: context.userId,
    });
    throw error;
  }
}

// ── Thread-Scoped Reconciliation Path ────────────────────────────────────────

async function extractWithReconciliation(
  context: ExtractionContext,
  workspaceId: string,
  extractionSourceRole: ExtractionSourceRole,
  start: number,
): Promise<void> {
  let existingMemories: Memory[] = [];
  const [threadMessages] = await Promise.all([
    fetchThreadMessages({
      channelId: context.channelId!,
      threadTs: context.threadTs!,
      limit: 30,
    }),
    retrieveMemories({
      query: context.userMessage,
      currentUserId: context.userId,
      limit: 20,
      workspaceId,
      adminMode: true,
    }).then((mems) => { existingMemories = mems; }).catch((err) => {
      logger.warn("Memory retrieval failed during reconciliation — proceeding with empty existing memories", {
        error: String(err?.message ?? err).slice(0, 200),
      });
    }),
  ]);

  if (threadMessages.length === 0) {
    logger.debug("No thread messages found — falling back to single-exchange extraction");
    return extractSingleExchange(context, workspaceId, extractionSourceRole, start);
  }

  const userIds = [...new Set(threadMessages.map((m) => m.userId).filter(Boolean))];
  const displayNames = new Map<string, string>();
  if (userIds.length > 0) {
    try {
      const dbUsers = await db
        .select({ slackUserId: users.slackUserId, displayName: users.displayName })
        .from(users)
        .where(inArray(users.slackUserId, userIds));
      for (const u of dbUsers) {
        if (u.slackUserId) displayNames.set(u.slackUserId, u.displayName);
      }
    } catch {
      logger.warn("Failed to resolve user display names from DB");
    }
  }
  if (context.displayName) {
    displayNames.set(context.userId, context.displayName);
  }

  const threadContext = buildThreadContext(threadMessages, displayNames);
  const { formatted: existingMemoriesText, refToId } = formatExistingMemories(existingMemories);

  const systemPrompt = RECONCILIATION_PROMPT.replace("{existingMemories}", () => existingMemoriesText);

  const model = await getFastModel();

  const { output: result } = await generateText({
    model,
    output: Output.object({ schema: reconciliationSchema }),
    system: systemPrompt,
    prompt: threadContext,
  });

  if (!result || result.operations.length === 0) {
    logger.debug("No memory operations from reconciliation");
    return;
  }

  const creates = result.operations.filter((op): op is z.infer<typeof createOperationSchema> => op.action === "create");
  const updates = result.operations.filter((op): op is z.infer<typeof updateOperationSchema> => op.action === "update");
  const deletes = result.operations.filter((op): op is z.infer<typeof deleteOperationSchema> => op.action === "delete");

  logger.info("Memory reconciliation operations", {
    creates: creates.length,
    updates: updates.length,
    deletes: deletes.length,
    threadMessages: threadMessages.length,
    existingMemories: existingMemories.length,
  });

  // Process DELETE operations
  for (const del of deletes) {
    const memoryId = refToId.get(del.memoryRef);
    if (memoryId) {
      try {
        await archiveMemory(memoryId, del.reason);
      } catch {
        logger.warn("Skipping delete because archive failed", {
          memoryId,
          ref: del.memoryRef,
        });
      }
    } else {
      logger.warn("Delete op referenced unknown memory", { ref: del.memoryRef });
    }
  }

  // Process UPDATE operations
  for (const upd of updates) {
    const memoryId = refToId.get(upd.memoryRef);
    if (!memoryId) {
      logger.warn("Update op referenced unknown memory", { ref: upd.memoryRef });
      continue;
    }
    let embedding: number[] | null = null;
    try {
      embedding = await embedText(upd.content);
    } catch {
      logger.warn("Failed to embed updated memory content", { ref: upd.memoryRef });
    }
    try {
      await updateMemoryContent(memoryId, upd.content, embedding, upd.importance ?? undefined);
    } catch {
      logger.warn("Skipping entity link refresh because content update failed", {
        memoryId,
        ref: upd.memoryRef,
      });
      continue;
    }

    // Keep memory_entities in sync with updated memory text.
    const extractedEntities = upd.entities ?? [];
    try {
      if (extractedEntities.length > 0) {
        await db.delete(memoryEntities).where(eq(memoryEntities.memoryId, memoryId));
        const resolved = await resolveEntities(extractedEntities, workspaceId, model);
        await linkMemoryEntities(memoryId, resolved);
      }
    } catch (entityError) {
      logger.warn("Failed to refresh entity links for updated memory", {
        memoryId,
        ref: upd.memoryRef,
        error: String(entityError),
      });
    }
  }

  // Process CREATE operations (same pipeline as single-exchange: importance filter, embed, dedup, store)
  if (creates.length > 0) {
    await processCreateOperations(creates, context, workspaceId, extractionSourceRole, model, start, "reconciliation");
  }
}

// ── Contradiction Detection ──────────────────────────────────────────────────

const contradictionResultSchema = z.object({
  results: z.array(z.object({
    candidateIndex: z.number().int().describe("0-based index of the candidate memory"),
    contradicts: z.boolean().describe("True only if the candidate makes a claim that directly conflicts with the new memory about the same entity/topic"),
    reason: z.string().describe("Brief explanation of why this is or is not a contradiction"),
  })),
});

const CONTRADICTION_PROMPT = `You are a memory contradiction detector. Given a NEW memory and a list of EXISTING candidate memories, determine if any existing memory **directly contradicts** the new one.

A contradiction means: both memories are about the SAME entity/topic, but make OPPOSITE or MUTUALLY EXCLUSIVE claims.

Examples of contradictions:
- "Alice has read-only access to repo X" vs "Alice has full admin access to repo X"
- "The team uses PostgreSQL" vs "The team uses MongoDB"
- "Project Alpha launches in Q1" vs "Project Alpha launches in Q3"

NOT contradictions (do not flag these):
- Refinements: "Alice works on frontend" → "Alice works on frontend and backend" (addition, not conflict)
- Different topics: "Alice likes coffee" vs "Alice prefers Slack over email" (unrelated)
- Temporal updates: "Sprint 5 goal is X" → "Sprint 6 goal is Y" (different time periods)
- Complementary facts: "Bob manages 3 reports" vs "Bob's team is growing" (compatible)

Be CONSERVATIVE — only flag true contradictions where both facts cannot simultaneously be true.`;

/**
 * Detect contradictions between newly stored memories and existing ones.
 * For each new memory, queries moderate-similarity neighbors (0.50–0.85 cosine)
 * that share relatedUserIds, then uses a fast LLM to check for semantic contradictions.
 * Contradicting old memories are superseded by the new one.
 */
async function detectContradictions(
  storedMemories: Array<{
    id: string;
    content: string;
    embedding: number[] | null;
    relatedUserIds: string[];
  }>,
  workspaceId: string,
  model: Awaited<ReturnType<typeof getFastModel>>,
): Promise<void> {
  for (const newMem of storedMemories) {
    if (!newMem.embedding || newMem.relatedUserIds.length === 0) continue;

    const candidates = await findContradictionCandidates(
      newMem.embedding,
      newMem.relatedUserIds,
      workspaceId,
      5,
    );

    if (candidates.length === 0) continue;

    try {
      const candidateList = candidates
        .map((c, i) => `[${i}] ${c.content}`)
        .join("\n");

      const { object } = await generateObject({
        model,
        schema: contradictionResultSchema,
        system: CONTRADICTION_PROMPT,
        prompt: `NEW MEMORY: ${newMem.content}\n\nEXISTING CANDIDATE MEMORIES:\n${candidateList}`,
        temperature: 0,
      });

      for (const result of object.results) {
        if (!result.contradicts) continue;
        const candidate = candidates[result.candidateIndex];
        if (!candidate) continue;

        logger.info("Contradiction detected — superseding old memory", {
          oldId: candidate.id,
          newId: newMem.id,
          reason: result.reason,
          similarity: candidate.similarity,
        });

        await supersedeMemory(candidate.id, newMem.id);
      }
    } catch (error) {
      logger.warn("Contradiction detection LLM call failed — skipping", {
        newMemoryId: newMem.id,
        candidateCount: candidates.length,
        error: String(error).slice(0, 200),
      });
    }
  }
}

async function processCreateOperations(
  creates: z.infer<typeof createOperationSchema>[],
  context: ExtractionContext,
  workspaceId: string,
  extractionSourceRole: ExtractionSourceRole,
  model: Awaited<ReturnType<typeof getFastModel>>,
  start: number,
  source: "reconciliation" | "single-exchange" = "reconciliation",
): Promise<void> {
  const filtered = creates.filter((m) => m.importance >= IMPORTANCE_DISCARD_THRESHOLD);
  if (filtered.length === 0) {
    logger.debug(`All new memories from ${source} were low importance`);
    return;
  }

  const normalizedMemories = await Promise.all(
    filtered.map(async (m) => ({
      ...m,
      relatedUserIds: await normalizeUserReferences(m.relatedUserIds),
    })),
  );

  const memoryTexts = normalizedMemories.map((m) => m.content);
  let embeddings: (number[] | null)[];
  try {
    embeddings = await embedTexts(memoryTexts);
  } catch {
    logger.error(`Memory embedding failed during ${source} — storing without embeddings`);
    embeddings = memoryTexts.map(() => null);
  }

  const dedupResults = await checkDuplicates(
    normalizedMemories.map((m, i) => ({ content: m.content, embedding: embeddings[i] ?? null })),
    workspaceId,
  );

  const survivingIndices = dedupResults
    .map((r, i) => (r.dominated ? -1 : i))
    .filter((i) => i >= 0);

  if (survivingIndices.length === 0) {
    logger.debug(`All new memories from ${source} were duplicates`);
    return;
  }

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
    importance: normalizedMemories[i].importance,
    relevanceScore: importanceToRelevance(normalizedMemories[i].importance),
    extractionSourceRole,
    ...(context.createdAt && { createdAt: context.createdAt, updatedAt: context.createdAt }),
  }));

  const memoryIds = await storeMemories(newMemories);

  for (let j = 0; j < survivingIndices.length; j++) {
    const i = survivingIndices[j];
    const oldId = dedupResults[i].supersedesId;
    const newId = memoryIds[j];
    if (oldId && newId) {
      await supersedeMemory(oldId, newId);
    }
  }

  // Contradiction detection: supersede existing memories that make
  // conflicting claims about the same entity/topic as a new memory.
  // Runs after dedup so we only check memories that survived dedup.
  try {
    const storedForContradiction = survivingIndices
      .map((i, j) => ({
        id: memoryIds[j],
        content: normalizedMemories[i].content,
        embedding: embeddings[i] ?? null,
        relatedUserIds: newMemories[j].relatedUserIds ?? [],
      }))
      .filter((m) => m.id);
    if (storedForContradiction.length > 0) {
      await detectContradictions(storedForContradiction, workspaceId, model);
    }
  } catch (error) {
    logger.warn("Contradiction detection pass failed — continuing without it", {
      error: String(error).slice(0, 200),
    });
  }

  for (let j = 0; j < survivingIndices.length; j++) {
    const i = survivingIndices[j];
    const extractedEntities = normalizedMemories[i].entities;
    if (extractedEntities && extractedEntities.length > 0 && memoryIds[j]) {
      try {
        const resolved = await resolveEntities(extractedEntities, workspaceId, model);
        await linkMemoryEntities(memoryIds[j], resolved);
      } catch (entityError) {
        logger.warn("Entity resolution failed for memory, skipping", {
          memoryId: memoryIds[j],
          error: String(entityError),
        });
      }
    }
  }

  logger.info(`${source === "reconciliation" ? "Reconciliation" : "Single-exchange extraction"} created ${newMemories.length} memories in ${Date.now() - start}ms`, {
    types: newMemories.map((m) => m.type),
  });
}

// ── Single-Exchange Fallback Path ────────────────────────────────────────────

async function extractSingleExchange(
  context: ExtractionContext,
  workspaceId: string,
  extractionSourceRole: ExtractionSourceRole,
  start: number,
): Promise<void> {
  const strippedAssistant = stripInjectedContext(context.assistantResponse);
  const includeAssistant = strippedAssistant.length >= MIN_STRIPPED_LENGTH;

  const conversationText = includeAssistant
    ? `User (${context.displayName || context.userId}): ${context.userMessage}\n\nAura: ${strippedAssistant}`
    : `User (${context.displayName || context.userId}): ${context.userMessage}`;

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

  const creates = object.memories
    .filter((m) => m.importance >= IMPORTANCE_DISCARD_THRESHOLD)
    .map((m) => ({
      ...m,
      action: "create" as const,
    }));

  const discardedCount = object.memories.length - creates.length;
  if (discardedCount > 0) {
    logger.info(`Filtered out ${discardedCount} low-importance memories (below ${IMPORTANCE_DISCARD_THRESHOLD})`);
  }

  if (creates.length === 0) {
    logger.debug("All extracted memories were low importance — nothing to store");
    return;
  }

  await processCreateOperations(creates, context, workspaceId, extractionSourceRole, model, start, "single-exchange");
}
