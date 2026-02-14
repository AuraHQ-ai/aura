import { generateText, Output } from "ai";
import { z } from "zod";
import { getFastModel } from "../lib/ai.js";
import { embedTexts } from "../lib/embeddings.js";
import { storeMemories } from "./store.js";
import { logger } from "../lib/logger.js";
import type { NewMemory } from "../db/schema.js";

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
  channelType: "dm" | "public_channel" | "private_channel";
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

    // Embed all extracted memories in a single batch
    const memoryTexts = object.memories.map((m) => m.content);
    const embeddings = await embedTexts(memoryTexts);

    // Prepare memories for storage
    const newMemories: NewMemory[] = object.memories.map((m, i) => ({
      content: m.content,
      type: m.type,
      sourceMessageId: context.sourceMessageId || undefined,
      sourceChannelType: context.channelType,
      relatedUserIds: m.relatedUserIds.length > 0 ? m.relatedUserIds : [context.userId],
      embedding: embeddings[i],
      shareable: m.shareable ? 1 : 0,
      relevanceScore: 1.0,
    }));

    await storeMemories(newMemories);

    logger.info(`Extracted ${newMemories.length} memories in ${Date.now() - start}ms`, {
      types: newMemories.map((m) => m.type),
    });
  } catch (error) {
    logger.error("Memory extraction failed", {
      error: String(error),
      userId: context.userId,
    });
    // Don't rethrow — extraction is best-effort and should not crash the pipeline
  }
}
