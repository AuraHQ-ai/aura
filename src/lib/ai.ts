import { gateway } from "@ai-sdk/gateway";

/**
 * All LLM and embedding calls go through Vercel AI Gateway.
 *
 * Models are configured via environment variables using the
 * `provider/model` format (e.g. "anthropic/claude-sonnet-4-20250514", "openai/gpt-4o").
 *
 * API keys for each provider are configured in the Vercel dashboard
 * under AI Gateway settings — not in this codebase.
 *
 * When deployed on Vercel, auth is handled automatically via OIDC.
 * For local development, set VERCEL_AI_GATEWAY_API_KEY in .env.
 */

/**
 * Model references — configured via env, centralised here.
 *
 * - `mainModel`      — conversation responses (quality matters)
 * - `fastModel`      — memory extraction, profile updates (speed/cost matters)
 * - `embeddingModel`  — embedding memories and queries
 */
export const mainModel = gateway(
  process.env.MODEL_MAIN || "anthropic/claude-sonnet-4-20250514",
);

export const fastModel = gateway(
  process.env.MODEL_FAST || "anthropic/claude-haiku-4.5",
);

export const embeddingModel = gateway.embedding(
  process.env.MODEL_EMBEDDING || "openai/text-embedding-3-small",
);
