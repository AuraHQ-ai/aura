import { gateway, GatewayAuthenticationError } from "@ai-sdk/gateway";
import {
  wrapLanguageModel,
  type LanguageModelMiddleware,
  type LanguageModelV3,
} from "ai";
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
  const gatewayId = await getMainModelId();
  const gatewayModel = gateway(gatewayId);
  return withAnthropicFallback(gatewayModel, gatewayId);
}

function toDirectAnthropicId(gatewayId: string): string | null {
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
function withAnthropicFallback(gatewayModel: LanguageModelV3, gatewayId: string): LanguageModelV3 {
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
  const gatewayModel = gateway.embedding(gatewayId);
  return withAnthropicFallback(gatewayModel, gatewayId);
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

export const embeddingModel = withAnthropicFallback(
  gateway.embedding(STATIC_EMBEDDING_MODEL_ID),
  STATIC_EMBEDDING_MODEL_ID,
);
