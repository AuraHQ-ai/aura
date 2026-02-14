import { gateway } from "@ai-sdk/gateway";
import { getSetting } from "./settings.js";

/**
 * All LLM and embedding calls go through Vercel AI Gateway.
 *
 * Models are resolved dynamically: DB settings take priority,
 * then env vars, then hardcoded defaults. This lets admins
 * change models from the Slack App Home without redeploying.
 *
 * When deployed on Vercel, auth is handled automatically via OIDC.
 * For local development, set VERCEL_AI_GATEWAY_API_KEY in .env.
 */

/**
 * Get the main conversation model.
 * Priority: DB setting > env var > default
 */
export async function getMainModel() {
  const override = await getSetting("model_main");
  return gateway(
    override || process.env.MODEL_MAIN || "anthropic/claude-sonnet-4-20250514",
  );
}

/**
 * Get the fast model (memory extraction, profile updates).
 * Priority: DB setting > env var > default
 */
export async function getFastModel() {
  const override = await getSetting("model_fast");
  return gateway(
    override || process.env.MODEL_FAST || "anthropic/claude-haiku-4-5",
  );
}

/**
 * Get the embedding model.
 * Priority: DB setting > env var > default
 */
export async function getEmbeddingModel() {
  const override = await getSetting("model_embedding");
  return gateway.embedding(
    override || process.env.MODEL_EMBEDDING || "openai/text-embedding-3-small",
  );
}

/**
 * Static references kept for backward compatibility where async isn't feasible.
 * These use env vars only (no DB lookup).
 */
export const mainModel = gateway(
  process.env.MODEL_MAIN || "anthropic/claude-sonnet-4-20250514",
);

export const fastModel = gateway(
  process.env.MODEL_FAST || "anthropic/claude-haiku-4-5",
);

export const embeddingModel = gateway.embedding(
  process.env.MODEL_EMBEDDING || "openai/text-embedding-3-small",
);
