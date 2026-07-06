import { z } from "zod";
import { aiTelemetry } from "../lib/langfuse.js";

const MAX_TITLE_CHARS = 100;

const dmThreadTitleSchema = z.object({
  title: z
    .string()
    .max(MAX_TITLE_CHARS)
    .nullable()
    .describe("Concise conversation topic, or null when no reliable topic should be set."),
  confidence: z
    .enum(["high", "low"])
    .describe("Use high only when the title names a concrete topic from the conversation."),
});

type DmThreadTitleResult = z.infer<typeof dmThreadTitleSchema>;

const INITIAL_TITLE_SYSTEM = `Create a short Slack DM thread title from the conversation.

Base the title on the user's underlying subject, not on the assistant's conversational behavior.
Return confidence "high" only when the title names a concrete topic from the user-visible conversation.
Return title null and confidence "low" when the available messages do not establish a concrete topic, or when the only salient content is refusal, uncertainty, capability limitation, apology, meta-commentary, or emotional state.

Title requirements:
- 3-8 words, or a similarly concise length for languages that do not use spaces.
- A noun phrase or topic label, not a sentence.
- No wrapping quotes and no trailing punctuation.`;

const UPDATE_TITLE_SYSTEM = `Create or update a short Slack DM thread title from the conversation.

Capture the concrete topic or topic arc of the conversation. Do not title the thread after the assistant's conversational behavior.
Return confidence "high" only when the title names a concrete topic from the user-visible conversation.
Return title null and confidence "low" when the available messages do not establish a concrete topic, or when the only salient content is refusal, uncertainty, capability limitation, apology, meta-commentary, or emotional state.

Title requirements:
- 5-10 words, or a similarly concise length for languages that do not use spaces.
- If multiple concrete topics are important, join them with " / ".
- No wrapping quotes and no trailing punctuation.`;

/** Strip wrapper characters and normalize whitespace without inspecting language content. */
export function sanitizeDmThreadTitle(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[.!?:;]+$/g, "")
    .trim();
}

function isStructurallyValidTitle(title: string): boolean {
  if (title.length < 2 || title.length > MAX_TITLE_CHARS) return false;
  if (!/[\p{L}\p{N}]/u.test(title)) return false;
  return true;
}

export function selectDmThreadTitle(result: DmThreadTitleResult): string | null {
  if (result.confidence !== "high" || result.title === null) return null;

  const title = sanitizeDmThreadTitle(result.title).slice(0, MAX_TITLE_CHARS);
  return isStructurallyValidTitle(title) ? title : null;
}

async function generateStructuredTitle(params: {
  instructions: string;
  prompt: string;
}): Promise<string | null> {
  const [{ generateObject }, { getFastModel }] = await Promise.all([
    import("ai"),
    import("../lib/ai.js"),
  ]);
  const fastModel = await getFastModel();

  const { object } = await generateObject({
    model: fastModel,
    schema: dmThreadTitleSchema,
    instructions: params.instructions,
    prompt: params.prompt,
    temperature: 0,
    telemetry: aiTelemetry("dm-title"),
  });

  return selectDmThreadTitle(object);
}

export async function generateInitialDmThreadTitle(params: {
  userMessage: string;
  assistantResponse: string;
}): Promise<string | null> {
  const { userMessage, assistantResponse } = params;
  return generateStructuredTitle({
    instructions: INITIAL_TITLE_SYSTEM,
    prompt: `User message:
${userMessage.slice(0, 600)}

Assistant response, for context only:
${assistantResponse.slice(0, 600)}`,
  });
}

export function formatRecentDmThreadMessages(params: {
  recentMessages: Array<{ displayName: string; text: string }>;
  messagesElided: boolean;
}): string {
  const { recentMessages, messagesElided } = params;
  if (!messagesElided) {
    return recentMessages
      .map((message) => `${message.displayName}: ${message.text.slice(0, 150)}`)
      .join("\n");
  }

  const half = Math.ceil(recentMessages.length / 2);
  return [
    "--- Start of conversation ---",
    ...recentMessages
      .slice(0, half)
      .map((message) => `${message.displayName}: ${message.text.slice(0, 150)}`),
    "--- ... ---",
    ...recentMessages
      .slice(half)
      .map((message) => `${message.displayName}: ${message.text.slice(0, 150)}`),
    "--- Latest ---",
  ].join("\n");
}

export async function generateUpdatedDmThreadTitle(params: {
  recentMessages: Array<{ displayName: string; text: string }>;
  messagesElided: boolean;
  assistantResponse: string;
}): Promise<string | null> {
  const { recentMessages, messagesElided, assistantResponse } = params;
  const messagesContext = formatRecentDmThreadMessages({
    recentMessages,
    messagesElided,
  });

  return generateStructuredTitle({
    instructions: UPDATE_TITLE_SYSTEM,
    prompt: `Conversation:
${messagesContext}

Latest assistant response, for context only:
${assistantResponse.slice(0, 300)}`,
  });
}
