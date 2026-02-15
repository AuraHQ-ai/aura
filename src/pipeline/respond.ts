import { generateText, stepCountIs } from "ai";
import type { WebClient } from "@slack/web-api";
import { getMainModel } from "../lib/ai.js";
import { postProcessResponse } from "../personality/anti-patterns.js";
import { formatForSlack } from "../slack/formatter.js";
import { createSlackTools } from "../tools/slack.js";
import type { SlackImage } from "../lib/files.js";
import { logger } from "../lib/logger.js";

interface RespondOptions {
  systemPrompt: string;
  userMessage: string;
  slackClient: WebClient;
  context?: { userId?: string; channelId?: string };
  images?: SlackImage[];
}

export interface LLMResponse {
  /** The raw LLM output */
  raw: string;
  /** Post-processed and formatted for Slack */
  formatted: string;
  /** Any anti-pattern modifications made */
  modifications: string[];
  /** Flagged words found */
  flaggedWords: string[];
  /** Token usage */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/**
 * Call the LLM and post-process the response.
 */
export async function generateResponse(
  options: RespondOptions,
): Promise<LLMResponse> {
  const start = Date.now();

  const model = await getMainModel();
  const hasImages = options.images && options.images.length > 0;

  // Build multimodal messages if images are present, otherwise use simple prompt
  const generateOptions: any = {
    model,
    system: options.systemPrompt,
    tools: createSlackTools(options.slackClient, options.context),
    stopWhen: stepCountIs(5),
  };

  if (hasImages) {
    // Multimodal: use messages format with content parts
    const content: any[] = [
      { type: "text", text: options.userMessage },
      ...options.images!.map((img) => ({
        type: "image",
        data: img.data,
        mimeType: img.mimeType,
      })),
    ];
    generateOptions.messages = [{ role: "user", content }];
  } else {
    generateOptions.prompt = options.userMessage;
  }

  const { text, usage } = await generateText(generateOptions);

  const llmMs = Date.now() - start;

  // Post-process: strip anti-patterns
  const { cleaned, flaggedWords, modifications } = postProcessResponse(text);

  // Format for Slack
  const formatted = formatForSlack(cleaned);

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totalTokens = inputTokens + outputTokens;

  logger.info(`LLM response generated in ${llmMs}ms`, {
    rawLength: text.length,
    cleanedLength: cleaned.length,
    modifications,
    flaggedWords,
    usage: { inputTokens, outputTokens, totalTokens },
  });

  return {
    raw: text,
    formatted,
    modifications,
    flaggedWords,
    usage: { inputTokens, outputTokens, totalTokens },
  };
}
