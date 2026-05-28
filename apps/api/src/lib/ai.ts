import { gateway, GatewayAuthenticationError } from "@ai-sdk/gateway";
import {
  wrapLanguageModel,
  type LanguageModelMiddleware,
} from "ai";

/** The model type that wrapLanguageModel accepts (LanguageModelV3, not re-exported by "ai"). */
export type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];
import { getSetting } from "./settings.js";
import { getDefaultModelId } from "./model-catalog.js";
import { logger } from "./logger.js";

/**
 * All LLM and embedding calls go through Vercel AI Gateway.
 *
 * Models are resolved dynamically: DB settings take priority,
 * then DB-backed catalog defaults. This lets admins
 * change models from the Slack App Home without redeploying.
 *
 * When deployed on Vercel, auth is handled automatically via OIDC.
 * For local development, set VERCEL_AI_GATEWAY_API_KEY in .env.local.
 *
 * All model functions automatically include Anthropic fallback middleware:
 * if the gateway returns a GatewayAuthenticationError (credits depleted,
 * OIDC unavailable), the call is retried against the Anthropic API
 * directly using ANTHROPIC_API_KEY.
 */

async function resolveModelId(
  settingKey: string,
  category: "main" | "fast" | "embedding" | "escalation",
): Promise<string> {
  const override = await getSetting(settingKey);
  if (override) return override;

  const defaultModelId = await getDefaultModelId(category);
  if (defaultModelId) return defaultModelId;

  throw new Error(`No default model configured for category: ${category}`);
}

/**
 * Resolve the main model ID string (no gateway wrapping).
 * Priority: DB setting > catalog default
 */
export async function getMainModelId(): Promise<string> {
  return resolveModelId("model_main", "main");
}

/**
 * Get the main conversation model with Anthropic fallback support.
 * Priority: DB setting > catalog default
 */
export async function getMainModel() {
  const modelId = await getMainModelId();
  const gatewayModel = gateway(modelId);
  return { modelId, model: withAnthropicFallback(gatewayModel, modelId) };
}

/**
 * Convert a Vercel AI Gateway model ID into a direct Anthropic API model ID.
 * Gateway uses dotted versions (e.g. "anthropic/claude-opus-4.7") while the
 * direct API uses dashed versions ("claude-opus-4-7"). Returns null for
 * non-Anthropic models.
 */
function toDirectAnthropicId(gatewayId: string): string | null {
  if (!gatewayId.startsWith("anthropic/")) return null;
  return gatewayId.slice("anthropic/".length).replace(/\./g, "-");
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
export function withAnthropicFallback(gatewayModel: WrappableModel, gatewayId: string): WrappableModel {
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
 * Priority: DB setting > catalog default.
 */
export async function getFastModel() {
  const gatewayId = await resolveModelId("model_fast", "fast");
  const gatewayModel = gateway(gatewayId);
  return withAnthropicFallback(gatewayModel, gatewayId);
}

/**
 * Get the embedding model with Anthropic fallback support.
 * Priority: DB setting > catalog default
 */
export async function getEmbeddingModel() {
  const gatewayId = await resolveModelId("model_embedding", "embedding");
  return gateway.embedding(gatewayId);
}

/**
 * Check if a model is Anthropic (used to decide where provider options apply).
 */
export function isAnthropicModel(modelId: string): boolean {
  return modelId.startsWith("anthropic/") || modelId.startsWith("claude");
}

/**
 * Get the escalation model for automatic model escalation.
 * Used when the default model is struggling — prepareStep can swap to this mid-conversation.
 * Priority: DB setting > catalog default
 */
export async function getEscalationModel() {
  const modelId = await resolveModelId("model_escalation", "escalation");
  const gatewayModel = gateway(modelId);
  return { modelId, model: withAnthropicFallback(gatewayModel, modelId) };
}













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

/**
 * Build a multi-breakpoint cached system message array for Anthropic prompt caching.
 *
 * Returns 2–3 system messages with cache control on the stable layers:
 *   1. stablePrefix (cached globally): personality + self-directive + auto-generated notes index
 *   2. conversationContext (cached per-thread): channel + user + memories + conversations + thread
 *   3. dynamicContext (uncached, optional): time, model, channelId, threadTs
 *
 * Safe for non-Anthropic models — they ignore providerOptions.anthropic.
 */
export function buildCachedSystemMessages(
  stablePrefix: string,
  conversationContext: string,
  dynamicContext?: string,
) {
  const messages: Array<{ role: 'system'; content: string; providerOptions?: Record<string, any> }> = [
    {
      role: 'system',
      content: stablePrefix,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
  ];
  if (conversationContext) {
    messages.push({
      role: 'system',
      content: conversationContext,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
  }
  if (dynamicContext) {
    messages.push({ role: 'system', content: dynamicContext });
  }
  return messages;

}

/**
 * Get the Cohere reranking model for semantic reranking.
 * Returns null if COHERE_API_KEY is not configured.
 */
export async function getRerankingModel() {
  if (!process.env.COHERE_API_KEY) {
    logger.debug("Cohere reranking disabled (no COHERE_API_KEY)");
    return null;
  }
  logger.debug("Cohere reranking enabled (rerank-v3.5)");
  const { createCohere } = await import("@ai-sdk/cohere");
  const cohere = createCohere({ apiKey: process.env.COHERE_API_KEY });
  return cohere.reranking("rerank-v3.5");
}
