import { gateway, GatewayAuthenticationError } from "@ai-sdk/gateway";
import {
  wrapLanguageModel,
  type LanguageModelMiddleware,
} from "ai";

/** The model type that wrapLanguageModel accepts (LanguageModelV3, not re-exported by "ai"). */
export type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];
import { getSetting } from "./settings.js";
import { logger } from "./logger.js";

/**
 * All LLM and embedding calls go through Vercel AI Gateway.
 *
 * Models are resolved dynamically: DB settings take priority,
 * then env vars, then hardcoded defaults. This lets admins
 * change models from the Slack App Home without redeploying.
 *
 * When deployed on Vercel, auth is handled automatically via OIDC.
 * For local development, set VERCEL_AI_GATEWAY_API_KEY in .env.
 *
 * All model functions automatically include Anthropic fallback middleware:
 * if the gateway returns a GatewayAuthenticationError (credits depleted,
 * OIDC unavailable), the call is retried against the Anthropic API
 * directly using ANTHROPIC_API_KEY.
 */

/** Default main model ID used across the codebase. */
export const DEFAULT_MAIN_MODEL = "anthropic/claude-sonnet-4-20250514";

/**
 * Resolve the main model ID string (no gateway wrapping).
 * Priority: DB setting > env var > default
 */
export async function getMainModelId(): Promise<string> {
  const override = await getSetting("model_main");
  return override || process.env.MODEL_MAIN || DEFAULT_MAIN_MODEL;
}

/**
 * Get the main conversation model with Anthropic fallback support.
 * Priority: DB setting > env var > default
 */
export async function getMainModel() {
  const modelId = await getMainModelId();
  const gatewayModel = gateway(modelId);
  return { modelId, model: withAnthropicFallback(gatewayModel, modelId) };
}

/**
 * Map Vercel AI Gateway model IDs to direct Anthropic API model IDs.
 * Gateway uses short names (e.g. "anthropic/claude-haiku-4-5") while
 * the direct API requires dated slugs (e.g. "claude-3-5-haiku-20241022").
 */
const GATEWAY_TO_ANTHROPIC: Record<string, string> = {
  "anthropic/claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "anthropic/claude-sonnet-4-20250514": "claude-sonnet-4-20250514",
  "anthropic/claude-opus-4-6": "claude-opus-4-6",
  "anthropic/claude-sonnet-4-5-20250514": "claude-sonnet-4-5-20250929",
  "anthropic/claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "anthropic/claude-sonnet-4-6": "claude-sonnet-4-6",
};

function toDirectAnthropicId(gatewayId: string): string | null {
  if (GATEWAY_TO_ANTHROPIC[gatewayId]) {
    return GATEWAY_TO_ANTHROPIC[gatewayId];
  }
  // Fallback: strip "anthropic/" prefix (works when gateway ID matches API ID)
  return gatewayId.startsWith("anthropic/")
    ? gatewayId.slice("anthropic/".length)
    : null;
}

async function getDirectAnthropicModel(modelId: string) {
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(modelId);
}

function gatewayFallbackMiddleware(
  directModelId: string,
): LanguageModelMiddleware {
  return {
    specificationVersion: "v3" as const,
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        return await doGenerate();
      } catch (error) {
        if (GatewayAuthenticationError.isInstance(error)) {
          logger.warn(
            "Gateway auth failed, falling back to direct Anthropic API",
            { model: directModelId },
          );
          const fallback = await getDirectAnthropicModel(directModelId);
          return await fallback.doGenerate(params);
        }
        throw error;
      }
    },
    wrapStream: async ({ doStream, params }) => {
      try {
        return await doStream();
      } catch (error) {
        if (GatewayAuthenticationError.isInstance(error)) {
          logger.warn(
            "Gateway auth failed (stream), falling back to direct Anthropic API",
            { model: directModelId },
          );
          const fallback = await getDirectAnthropicModel(directModelId);
          return await fallback.doStream(params);
        }
        throw error;
      }
    },
  };
}

/**
 * Universal helper that adds Anthropic fallback to any gateway model.
 * For non-Anthropic models, returns the model unchanged.
 * For Anthropic models, wraps with fallback middleware.
 */
function withAnthropicFallback(gatewayModel: WrappableModel, gatewayId: string): WrappableModel {
  const directId = toDirectAnthropicId(gatewayId);
  if (!directId) {
    return gatewayModel;
  }

  return wrapLanguageModel({
    model: gatewayModel,
    middleware: gatewayFallbackMiddleware(directId),
  });
}

/**
 * Get the fast model (memory extraction, profile updates) with Anthropic fallback support.
 * Priority: DB setting > env var > default.
 */
export async function getFastModel() {
  const override = await getSetting("model_fast");
  const gatewayId =
    override || process.env.MODEL_FAST || "anthropic/claude-haiku-4-5";
  const gatewayModel = gateway(gatewayId);
  return withAnthropicFallback(gatewayModel, gatewayId);
}

/**
 * Get the embedding model with Anthropic fallback support.
 * Priority: DB setting > env var > default
 */
export async function getEmbeddingModel() {
  const override = await getSetting("model_embedding");
  const gatewayId =
    override || process.env.MODEL_EMBEDDING || "openai/text-embedding-3-small";
  return gateway.embedding(gatewayId);
}

/**
 * Check if a model ID refers to an Anthropic model.
 * Matches gateway IDs (anthropic/claude-...) and direct IDs (claude-...).
 */
export function isAnthropicModel(modelId: string): boolean {
  return modelId.startsWith("anthropic/") || modelId.includes("claude");
}

/**
 * Check if a model supports the Anthropic `effort` parameter.
 * Currently supported: Claude Opus 4.5, Opus 4.6, and Sonnet 4.6.
 */
export function supportsEffort(modelId: string): boolean {
  return /claude-(?:opus-4-[56]|sonnet-4-6)/.test(modelId);
}

/**
 * Build Anthropic context management configuration.
 * Combines two strategies:
 * 1. Clear old tool uses at 60K tokens (keep last 5)
 * 2. Compact (summarize) at 80K tokens
 *
 * Note: clear_thinking_20251015 is omitted because it requires `thinking`
 * to be explicitly enabled or adaptive. We use `effort` instead, which
 * doesn't satisfy that requirement and causes 400 errors across all
 * gateway providers.
 */
export function buildContextManagement() {
  return {
    edits: [
      {
        type: "clear_tool_uses_20250919" as const,
        trigger: { type: "input_tokens" as const, value: 60000 },
        keep: { type: "tool_uses" as const, value: 5 },
        clearToolInputs: true,
      },
      {
        type: "compact_20260112" as const,
        trigger: { type: "input_tokens" as const, value: 80000 },
        instructions:
          "Preserve: current task state and goal, key decisions made, error patterns found, " +
          "file paths being investigated, user preferences learned, thread context (channel, thread_ts), " +
          "and any data/metrics discovered. Drop: verbatim tool outputs that have been summarized, " +
          "intermediate failed attempts, redundant search results.",
      },
    ],
  };
}

/**
 * Get the escalation model for automatic model escalation.
 * Used when the default model is struggling — prepareStep can swap to this mid-conversation.
 * Priority: DB setting > env var > default (Opus 4.6)
 */
export async function getEscalationModel() {
  const override = await getSetting("model_escalation");
  const modelId =
    override || process.env.MODEL_ESCALATION || "anthropic/claude-opus-4-6";
  const gatewayModel = gateway(modelId);
  return { modelId, model: withAnthropicFallback(gatewayModel, modelId) };
}













/**
 * Static references kept for backward compatibility where async isn't feasible.
 * These use env vars only (no DB lookup) and include Anthropic fallback support.
 */
const STATIC_MAIN_MODEL_ID = process.env.MODEL_MAIN || "anthropic/claude-sonnet-4-20250514";
const STATIC_FAST_MODEL_ID = process.env.MODEL_FAST || "anthropic/claude-haiku-4-5";
const STATIC_EMBEDDING_MODEL_ID = process.env.MODEL_EMBEDDING || "openai/text-embedding-3-small";

export const mainModel = withAnthropicFallback(
  gateway(STATIC_MAIN_MODEL_ID),
  STATIC_MAIN_MODEL_ID,
);

export const fastModel = withAnthropicFallback(
  gateway(STATIC_FAST_MODEL_ID),
  STATIC_FAST_MODEL_ID,
);

export const embeddingModel = gateway.embedding(STATIC_EMBEDDING_MODEL_ID);

/**
 * Wrap a system prompt string with Anthropic cache control.
 * Returns a SystemModelMessage with providerOptions that enable ephemeral caching.
 * Safe for non-Anthropic models — they ignore the providerOptions.anthropic key.
 */
export function withCacheControl(systemPrompt: string) {
  return {
    role: 'system' as const,
    content: systemPrompt,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  };
}
