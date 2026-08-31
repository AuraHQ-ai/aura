import { gateway, GatewayAuthenticationError } from "@ai-sdk/gateway";
import {
  addToolInputExamplesMiddleware,
  wrapLanguageModel,
  type LanguageModelMiddleware,
} from "ai";

/** The model type that wrapLanguageModel accepts (LanguageModelV3, not re-exported by "ai"). */
export type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];
import { getSetting } from "./settings.js";
import { type ModelCategory, updateModelCapabilities } from "./model-catalog.js";
import { logger } from "./logger.js";
import { recordError } from "./metrics.js";
import {
  hasDeferredLoading,
  withoutDeferredLoading,
} from "../tools/deferred-loading.js";
import {
  getProviderThinkingOptions,
  resolveProviderThinkingOptions,
} from "../pipeline/prepare-step.js";
import type { ModelCapabilities } from "@aura/db/schema";

/**
 * All LLM and embedding calls go through Vercel AI Gateway.
 *
 * Models are resolved dynamically: DB settings take priority,
 * then an explicit hardcoded last-resort constant map. This lets admins
 * change models from the Slack App Home without redeploying.
 *
 * Resolution order (see LAST_RESORT_MODELS below):
 *   1. settings row (model_main / model_fast / model_medium / model_escalation / model_embedding)
 *   2. Hardcoded LAST_RESORT_MODELS — logs a warning so operators notice the gap
 *
 * Note: model_catalog_selections has been removed. Resolution uses only the
 * settings row and LAST_RESORT_MODELS.
 *
 * When deployed on Vercel, auth is handled automatically via OIDC.
 * For local development, set VERCEL_AI_GATEWAY_API_KEY in .env.local.
 *
 * All model functions automatically include Anthropic fallback middleware:
 * if the gateway returns a GatewayAuthenticationError (credits depleted,
 * OIDC unavailable), the call is retried against the Anthropic API
 * directly using ANTHROPIC_API_KEY.
 */

/**
 * Last-resort model IDs used when no settings row exists for a category.
 * These are gateway model IDs (provider/model-name format with dotted versions).
 * Update this map when a newer default is desired — it is the single source
 * of truth for the fallback path.
 */
export const LAST_RESORT_MODELS: Record<ModelCategory, string> = {
  main:      "anthropic/claude-sonnet-4.5",
  fast:      "anthropic/claude-haiku-4.5",
  medium:    "anthropic/claude-sonnet-4.5",
  embedding: "openai/text-embedding-3-small",
  escalation:"anthropic/claude-opus-4.5",
};

async function resolveModelId(
  settingKey: string,
  category: ModelCategory,
): Promise<string> {
  const override = await getSetting(settingKey);
  if (override) return override;

  const fallback = LAST_RESORT_MODELS[category];
  if (!fallback) {
    throw new Error(`No last-resort model configured for unknown category: ${category}`);
  }
  logger.warn("No DB setting for model category, using last-resort default", {
    category,
    fallback,
  });
  return fallback;
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

const ENABLED_THINKING_UNSUPPORTED =
  "\"thinking.type.enabled\" is not supported for this model";
const ADAPTIVE_THINKING_UNSUPPORTED =
  "adaptive thinking is not supported on this model";

function errorIncludes(error: unknown, needle: string): boolean {
  if (error instanceof Error) {
    if (error.message.includes(needle) || String(error).includes(needle)) {
      return true;
    }

    const cause = (error as { cause?: unknown }).cause;
    if (cause && errorIncludes(cause, needle)) {
      return true;
    }

    const nested = (error as { errors?: unknown }).errors;
    if (Array.isArray(nested)) {
      return nested.some((item) => errorIncludes(item, needle));
    }

    return false;
  }

  return String(error).includes(needle);
}

function getSelfHealedAnthropicCapabilities(
  error: unknown,
): ModelCapabilities | null {
  if (errorIncludes(error, ENABLED_THINKING_UNSUPPORTED)) {
    return { provider: "anthropic", thinkingMode: "adaptive" };
  }
  if (errorIncludes(error, ADAPTIVE_THINKING_UNSUPPORTED)) {
    return { provider: "anthropic", thinkingMode: "enabled" };
  }
  return null;
}

function getBudgetTokensFromParams(params: unknown): number {
  const thinking = (params as any)?.providerOptions?.anthropic?.thinking;
  return typeof thinking?.budgetTokens === "number" ? thinking.budgetTokens : 8000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeProviderOptions(
  existing: unknown,
  corrected: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};

  for (const [provider, options] of Object.entries(corrected)) {
    const existingProviderOptions = merged[provider];
    merged[provider] = {
      ...(isRecord(existingProviderOptions) ? existingProviderOptions : {}),
      ...(isRecord(options) ? options : {}),
    };
  }

  return merged;
}

type SelfHealRetryResult<T> =
  | { healed: false }
  | { healed: true; result: T };

async function retryWithSelfHealedThinking<T>(opts: {
  error: unknown;
  gatewayId: string;
  params: unknown;
  retry: (params: any) => PromiseLike<T>;
}): Promise<SelfHealRetryResult<T>> {
  const capabilities = getSelfHealedAnthropicCapabilities(opts.error);
  if (!capabilities) return { healed: false };

  const wrote = await updateModelCapabilities(opts.gatewayId, capabilities);
  logger.info("Self-healed Anthropic thinking capabilities", {
    modelId: opts.gatewayId,
    capabilities,
    persisted: wrote,
  });

  const budgetTokens = getBudgetTokensFromParams(opts.params);
  let correctedProviderOptions = await getProviderThinkingOptions(
    opts.gatewayId,
    budgetTokens,
  ).catch(() =>
    resolveProviderThinkingOptions(opts.gatewayId, capabilities, budgetTokens),
  );

  if (Object.keys(correctedProviderOptions).length === 0) {
    correctedProviderOptions = resolveProviderThinkingOptions(
      opts.gatewayId,
      capabilities,
      budgetTokens,
    );
  }

  const retryParams = {
    ...(isRecord(opts.params) ? opts.params : {}),
    providerOptions: mergeProviderOptions(
      (opts.params as any)?.providerOptions,
      correctedProviderOptions as Record<string, unknown>,
    ),
  };

  return { healed: true, result: await opts.retry(retryParams) };
}

/**
 * Matches provider capability-divergence errors like
 *   "tools.10.custom.input_examples: Extra inputs are not permitted"
 * — e.g. Bedrock's Anthropic passthrough rejecting a tool field that the
 * anthropic/vertex upstreams accept (the gateway free-routes across all
 * three). Captures the offending field name (last path segment).
 */
const UNSUPPORTED_TOOL_FIELD_PATTERN =
  /tools\.\d+(?:\.[\w$-]+)*\.([\w$-]+)\s*:\s*Extra inputs are not permitted/;

function collectErrorMessages(error: unknown, acc: string[] = []): string[] {
  if (error instanceof Error) {
    acc.push(error.message, String(error));

    const cause = (error as { cause?: unknown }).cause;
    if (cause) collectErrorMessages(cause, acc);

    const nested = (error as { errors?: unknown }).errors;
    if (Array.isArray(nested)) {
      for (const item of nested) collectErrorMessages(item, acc);
    }
  } else if (error != null) {
    acc.push(String(error));
  }
  return acc;
}

function findUnsupportedToolField(error: unknown): string | null {
  for (const message of collectErrorMessages(error)) {
    const match = UNSUPPORTED_TOOL_FIELD_PATTERN.exec(message);
    if (match) return match[1];
  }
  return null;
}

function snakeToCamel(field: string): string {
  return field.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

/**
 * Return a copy of the tools array with the offending field removed from
 * every tool, or null if no tool carried it (so a retry would be pointless).
 * The provider reports the wire-format (snake_case) field name while the
 * middleware-level tool objects use camelCase — strip both spellings.
 */
function stripFieldFromTools(tools: unknown, field: string): unknown[] | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const candidates = new Set([field, snakeToCamel(field)]);
  let stripped = false;

  const next = tools.map((tool) => {
    if (!isRecord(tool)) return tool;
    const present = [...candidates].filter((name) => name in tool);
    if (present.length === 0) return tool;
    stripped = true;
    const copy = { ...tool };
    for (const name of present) delete copy[name];
    return copy;
  });

  return stripped ? next : null;
}

/**
 * Self-heal gateway "Extra inputs are not permitted" errors caused by
 * provider capability divergence (one gateway upstream rejects a tool field
 * that others accept): strip the offending field from every tool and retry
 * once. Safety net — addToolInputExamplesMiddleware should prevent the known
 * inputExamples case from ever reaching the provider.
 */
async function retryWithStrippedToolField<T>(opts: {
  error: unknown;
  gatewayId: string;
  params: unknown;
  retry: (params: any) => PromiseLike<T>;
}): Promise<SelfHealRetryResult<T>> {
  const field = findUnsupportedToolField(opts.error);
  if (!field) return { healed: false };

  const strippedTools = stripFieldFromTools((opts.params as any)?.tools, field);
  if (!strippedTools) return { healed: false };

  logger.warn(
    "Gateway upstream rejected a tool field (provider capability divergence), stripping it and retrying",
    { field, modelId: opts.gatewayId },
  );

  const retryParams = {
    ...(isRecord(opts.params) ? opts.params : {}),
    tools: strippedTools,
  };
  return { healed: true, result: await opts.retry(retryParams) };
}

/**
 * Matches the provider validation error emitted when a server-tool result
 * block goes missing from the conversation, e.g. Bedrock's Anthropic
 * passthrough dropping the tool_search_bm25 result block (issue #1375):
 *   "messages.1: `tool_search_tool_bm25` tool use with id
 *    `srvtoolu_bdrk_...` was found without a corresponding
 *    `tool_search_tool_bm25_tool_result` block"
 * Captures the offending tool name.
 */
const MISSING_TOOL_RESULT_PATTERN =
  /`([\w$-]+)` tool use with id `[^`]+` was found without a corresponding `\1_tool_result` block/;

function findMissingToolResultName(error: unknown): string | null {
  for (const message of collectErrorMessages(error)) {
    const match = MISSING_TOOL_RESULT_PATTERN.exec(message);
    if (match) return match[1];
  }
  return null;
}

/** The tool-map key applyAnthropicToolDiscovery uses for the BM25 meta-tool. */
const TOOL_SEARCH_NAME = "toolSearch";

function isToolSearchTool(tool: unknown): boolean {
  if (!isRecord(tool)) return false;
  if (tool.name === TOOL_SEARCH_NAME) return true;
  // Provider-defined tool ids look like "anthropic.tool_search_tool_bm25_20251119".
  return typeof tool.id === "string" && tool.id.includes("tool_search");
}

/**
 * Return a copy of the tools array with the toolSearch meta-tool removed and
 * every deferred tool materialised (deferLoading marker stripped so the model
 * sees full schemas up front), or null if no tool carried the deferred marker
 * and there was no toolSearch (so a retry would be pointless).
 */
function materializeDeferredTools(tools: unknown): unknown[] | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;

  let changed = false;
  const next: unknown[] = [];
  for (const tool of tools) {
    if (isToolSearchTool(tool)) {
      changed = true;
      continue;
    }
    if (hasDeferredLoading(tool)) {
      changed = true;
      next.push(withoutDeferredLoading(tool));
      continue;
    }
    next.push(tool);
  }
  return changed ? next : null;
}

/**
 * Self-heal gateway "tool use without a corresponding tool_result" errors
 * caused by an upstream dropping server-tool result blocks (Bedrock's
 * Anthropic passthrough drops tool_search_bm25 results while anthropic/vertex
 * return them — the gateway free-routes across all three, issue #1375):
 * drop the toolSearch meta-tool, materialise every deferred tool's schema,
 * and retry once. Deferred loading is a token optimisation — losing it for
 * one turn is strictly better than losing the whole run.
 */
async function retryWithMaterializedTools<T>(opts: {
  error: unknown;
  gatewayId: string;
  params: unknown;
  retry: (params: any) => PromiseLike<T>;
  /** Invoked when the heal fires, before the retry (used for sticky avoidance). */
  onHeal?: () => void;
}): Promise<SelfHealRetryResult<T>> {
  const toolName = findMissingToolResultName(opts.error);
  if (!toolName) return { healed: false };

  const materializedTools = materializeDeferredTools((opts.params as any)?.tools);
  if (!materializedTools) return { healed: false };

  recordError("gateway.missing_tool_result", opts.error, {
    modelId: opts.gatewayId,
    toolName,
    heal: "removed toolSearch meta-tool and materialized deferred tool schemas, retrying once",
  });

  opts.onHeal?.();

  const retryParams = {
    ...(isRecord(opts.params) ? opts.params : {}),
    tools: materializedTools,
  };
  return { healed: true, result: await opts.retry(retryParams) };
}

function gatewayFallbackMiddleware(
  directModelId: string,
  gatewayId: string,
  gatewayModel: WrappableModel,
): LanguageModelMiddleware {
  // Sticky avoidance for the missing-tool_result heal (issue #1375): once a
  // step has healed by dropping toolSearch, don't re-attach it for the
  // remaining steps of the turn — every subsequent step would pay the same
  // failure + retry. Scoped to this wrapped model instance (models are built
  // per invocation), so it cannot leak across invocations.
  let toolSearchDegraded = false;
  const markToolSearchDegraded = () => {
    toolSearchDegraded = true;
  };

  return {
    specificationVersion: "v3" as const,
    transformParams: async ({ params }) => {
      if (!toolSearchDegraded) return params;
      const materializedTools = materializeDeferredTools((params as any)?.tools);
      if (!materializedTools) return params;
      return { ...params, tools: materializedTools } as typeof params;
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        return await doGenerate();
      } catch (error) {
        const healed = await retryWithSelfHealedThinking<
          Awaited<ReturnType<typeof doGenerate>>
        >({
          error,
          gatewayId,
          params,
          retry: (retryParams) =>
            gatewayModel.doGenerate(retryParams) as ReturnType<typeof doGenerate>,
        });
        if (healed.healed) return healed.result;

        const strippedField = await retryWithStrippedToolField<
          Awaited<ReturnType<typeof doGenerate>>
        >({
          error,
          gatewayId,
          params,
          retry: (retryParams) =>
            gatewayModel.doGenerate(retryParams) as ReturnType<typeof doGenerate>,
        });
        if (strippedField.healed) return strippedField.result;

        const materialized = await retryWithMaterializedTools<
          Awaited<ReturnType<typeof doGenerate>>
        >({
          error,
          gatewayId,
          params,
          retry: (retryParams) =>
            gatewayModel.doGenerate(retryParams) as ReturnType<typeof doGenerate>,
          onHeal: markToolSearchDegraded,
        });
        if (materialized.healed) return materialized.result;

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
        const healed = await retryWithSelfHealedThinking<
          Awaited<ReturnType<typeof doStream>>
        >({
          error,
          gatewayId,
          params,
          retry: (retryParams) =>
            gatewayModel.doStream(retryParams) as ReturnType<typeof doStream>,
        });
        if (healed.healed) return healed.result;

        const strippedField = await retryWithStrippedToolField<
          Awaited<ReturnType<typeof doStream>>
        >({
          error,
          gatewayId,
          params,
          retry: (retryParams) =>
            gatewayModel.doStream(retryParams) as ReturnType<typeof doStream>,
        });
        if (strippedField.healed) return strippedField.result;

        const materialized = await retryWithMaterializedTools<
          Awaited<ReturnType<typeof doStream>>
        >({
          error,
          gatewayId,
          params,
          retry: (retryParams) =>
            gatewayModel.doStream(retryParams) as ReturnType<typeof doStream>,
          onHeal: markToolSearchDegraded,
        });
        if (materialized.healed) return materialized.result;

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
 * Universal helper that wraps every model we build with the shared
 * middleware chain:
 *
 * 1. addToolInputExamplesMiddleware (all models) — folds each tool's
 *    inputExamples into its description and strips the field before the
 *    provider serialises the tools. Some gateway upstreams (Bedrock's
 *    Anthropic passthrough) reject the serialised `input_examples` field
 *    with "Extra inputs are not permitted" while anthropic/vertex accept
 *    it, so the field must never reach the provider (issue #1353).
 * 2. gatewayFallbackMiddleware (Anthropic models only) — self-heals
 *    thinking-mode mismatches and capability-divergence errors (including
 *    upstreams dropping tool_search result blocks, issue #1375), and falls
 *    back to the direct Anthropic API on gateway auth failures.
 *
 * Order matters: the examples middleware is first (outermost), so the
 * fallback middleware — and every retry/fallback path inside it — only ever
 * sees params with inputExamples already stripped.
 */
export function withAnthropicFallback(gatewayModel: WrappableModel, gatewayId: string): WrappableModel {
  const middleware: LanguageModelMiddleware[] = [
    addToolInputExamplesMiddleware(),
  ];

  const directId = toDirectAnthropicId(gatewayId);
  if (directId) {
    middleware.push(gatewayFallbackMiddleware(directId, gatewayId, gatewayModel));
  }

  return wrapLanguageModel({
    model: gatewayModel,
    middleware,
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

/** Resolve the fast model ID string (no gateway wrapping). */
export async function getFastModelId(): Promise<string> {
  return resolveModelId("model_fast", "fast");
}

/**
 * Resolve the medium model ID string (no gateway wrapping).
 * Priority: DB setting > LAST_RESORT_MODELS.medium
 */
export async function getMediumModelId(): Promise<string> {
  return resolveModelId("model_medium", "medium");
}

/**
 * Get the medium model (Sonnet-class — default tier for scheduled jobs)
 * with Anthropic fallback support.
 * Priority: DB setting > catalog default > main model fallback.
 */
export async function getMediumModel() {
  const modelId = await getMediumModelId();
  const gatewayModel = gateway(modelId);
  return { modelId, model: withAnthropicFallback(gatewayModel, modelId) };
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
 * Model categories a job can be routed to (subset of the catalog categories —
 * 'embedding' makes no sense for text generation).
 */
export const JOB_MODEL_CATEGORIES = ["main", "fast", "medium", "escalation"] as const;
export type JobModelCategory = (typeof JOB_MODEL_CATEGORIES)[number];

export function isJobModelCategory(value: unknown): value is JobModelCategory {
  return (
    typeof value === "string" &&
    JOB_MODEL_CATEGORIES.includes(value as JobModelCategory)
  );
}

const SETTING_KEY_BY_CATEGORY: Record<JobModelCategory, string> = {
  main: "model_main",
  fast: "model_fast",
  medium: "model_medium",
  escalation: "model_escalation",
};

/**
 * Resolve a language model by catalog category. Same resolution order as the
 * dedicated getters (DB setting > catalog default), with Anthropic fallback.
 * Used by scoped job execution to route a job to e.g. the fast model.
 * 'medium' additionally falls back to the main model when unconfigured.
 */
export async function getModelByCategory(category: JobModelCategory) {
  if (category === "medium") return getMediumModel();
  const modelId = await resolveModelId(SETTING_KEY_BY_CATEGORY[category], category);
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
 * Layers are ordered by volatility (most stable first), with cache control on
 * the three stable layers and the volatile runtime tail left uncached:
 *   1. stablePrefix (cached globally): personality + self-directive + notes index
 *      — byte-identical across every user and thread.
 *   2. environmentContext (cached per-user): capabilities + storage + deferred tools
 *      — "what you can do"; stable across a user's threads. Sits AHEAD of the
 *      conversation so it caches and is never stranded in the uncached tail.
 *   3. conversationContext (cached per-turn): channel + user + memories + threads
 *      + the serialized conversation — constant across the steps of one response.
 *   4. dynamicContext (UNcached, optional): current time, model, channel, usage
 *      — the only genuinely volatile layer; kept last so it never busts a cache.
 *
 * Uses 3 cache breakpoints (Anthropic allows 4). Empty layers are skipped.
 * Safe for non-Anthropic models — they ignore providerOptions.anthropic.
 */
export function buildCachedSystemMessages(
  stablePrefix: string,
  environmentContext: string,
  conversationContext: string,
  dynamicContext?: string,
) {
  const ephemeral = { anthropic: { cacheControl: { type: 'ephemeral' } } };
  const messages: Array<{ role: 'system'; content: string; providerOptions?: Record<string, any> }> = [
    {
      role: 'system',
      content: stablePrefix,
      providerOptions: ephemeral,
    },
  ];
  if (environmentContext) {
    messages.push({
      role: 'system',
      content: environmentContext,
      providerOptions: ephemeral,
    });
  }
  if (conversationContext) {
    messages.push({
      role: 'system',
      content: conversationContext,
      providerOptions: ephemeral,
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
