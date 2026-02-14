import { generateText, stepCountIs } from "ai";
import type { WebClient } from "@slack/web-api";
import { mainModel } from "../lib/ai.js";
import { postProcessResponse } from "../personality/anti-patterns.js";
import { formatForSlack } from "../slack/formatter.js";
import { createSlackTools } from "../tools/slack.js";
import { logger } from "../lib/logger.js";

interface RespondOptions {
  systemPrompt: string;
  userMessage: string;
  slackClient: WebClient;
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

  const { text, usage } = await generateText({
    model: mainModel,
    system: options.systemPrompt,
    prompt: options.userMessage,
    tools: createSlackTools(options.slackClient),
    stopWhen: stepCountIs(5),
  });

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
