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
import { logError } from "./error-logger.js";
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

// ── Anthropic server-side tool divergence (issue #1357) ─────────────────────
// applyAnthropicToolDiscovery injects Anthropic *server-side* tools (BM25
// tool search) for `anthropic/*` models. The gateway free-routes those models
// across the anthropic, bedrock, and vertex upstreams, and the
// non-first-party upstreams either reject the tool type outright or emit the
// server `tool_use` block without ever returning the matching tool_result —
// which then fails schema validation on the next call. prepare-step pins the
// gateway to the first-party upstream when server tools are present; this
// middleware is the safety net for any path that misses the pin: strip the
// server tools (and any stranded server tool_use/tool_result parts they left
// in the prompt) and retry once. Degrading to "no BM25 tool discovery" is
// strictly better than a hard job failure.

const UNSUPPORTED_SERVER_TOOL_TYPE_PATTERN =
  /tool type '([\w.-]+)' is not supported for this model/;
// Server tool ids: `srvtoolu_01...` (first-party), `srvtoolu_bdrk_...`
// (Bedrock), `srvtoolu_vrtx_...` (Vertex). Captures the upstream prefix.
const ORPHANED_SERVER_TOOL_USE_PATTERN =
  /tool use with id `?srvtoolu_(?:(bdrk|vrtx)_)?[A-Za-z0-9_]+`? was found without a corresponding/;

interface AnthropicServerToolError {
  reason: "unsupported_tool_type" | "orphaned_server_tool_use";
  /** Gateway upstream inferred from the tool id ("bdrk"/"vrtx"), if any. */
  upstreamPrefix: string | null;
  matchedMessage: string;
}

function findAnthropicServerToolError(
  error: unknown,
): AnthropicServerToolError | null {
  for (const message of collectErrorMessages(error)) {
    const unsupported = UNSUPPORTED_SERVER_TOOL_TYPE_PATTERN.exec(message);
    if (unsupported) {
      return {
        reason: "unsupported_tool_type",
        upstreamPrefix: null,
        matchedMessage: unsupported[0],
      };
    }
    const orphaned = ORPHANED_SERVER_TOOL_USE_PATTERN.exec(message);
    if (orphaned) {
      return {
        reason: "orphaned_server_tool_use",
        upstreamPrefix: orphaned[1] ?? null,
        matchedMessage: orphaned[0],
      };
    }
  }
  return null;
}

/** LanguageModelV3-level view of an Anthropic server-side tool. */
function isAnthropicServerToolParam(tool: unknown): boolean {
  if (!isRecord(tool)) return false;
  return (
    (tool.type === "provider" || tool.type === "provider-defined") &&
    typeof tool.id === "string" &&
    tool.id.startsWith("anthropic.")
  );
}

/**
 * Return the tools array without Anthropic server-side tools plus the names
 * of the removed tools, or null if none were present (retry would be
 * pointless).
 */
function stripAnthropicServerTools(
  tools: unknown,
): { tools: unknown[]; strippedNames: string[] } | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const strippedNames: string[] = [];
  const kept = tools.filter((tool) => {
    if (!isAnthropicServerToolParam(tool)) return true;
    const record = tool as Record<string, unknown>;
    strippedNames.push(
      typeof record.name === "string" ? record.name : String(record.id),
    );
    return false;
  });

  return strippedNames.length > 0 ? { tools: kept, strippedNames } : null;
}

/**
 * Remove server-tool call/result parts that a non-first-party upstream left
 * stranded in the message history (server tool ids are prefixed
 * `srvtoolu_`). Leaving them in place would re-trigger the same "found
 * without a corresponding tool_result" validation error on the retry, and
 * once the server tool is stripped from the request the provider can no
 * longer resolve the referenced tool anyway. Messages left empty by the
 * scrub are dropped.
 */
function scrubServerToolParts(prompt: unknown, strippedNames: string[]): unknown {
  if (!Array.isArray(prompt)) return prompt;
  const names = new Set(strippedNames);

  const isServerToolPart = (part: unknown): boolean => {
    if (!isRecord(part)) return false;
    if (part.type !== "tool-call" && part.type !== "tool-result") return false;
    return (
      (typeof part.toolCallId === "string" &&
        part.toolCallId.startsWith("srvtoolu_")) ||
      (typeof part.toolName === "string" && names.has(part.toolName))
    );
  };

  return prompt
    .map((message) => {
      if (!isRecord(message) || !Array.isArray(message.content)) return message;
      if (message.role !== "assistant" && message.role !== "tool") return message;
      const content = message.content.filter((part) => !isServerToolPart(part));
      return content.length === message.content.length
        ? message
        : { ...message, content };
    })
    .filter(
      (message) =>
        !(
          isRecord(message) &&
          (message.role === "assistant" || message.role === "tool") &&
          Array.isArray(message.content) &&
          message.content.length === 0
        ),
    );
}

/**
 * Self-heal gateway failures caused by Anthropic server-side tools reaching a
 * non-first-party upstream (Bedrock/Vertex): strip the server tools, scrub
 * any stranded server tool parts from the prompt, and retry once.
 */
async function retryWithStrippedServerTools<T>(opts: {
  error: unknown;
  gatewayId: string;
  params: unknown;
  retry: (params: any) => PromiseLike<T>;
}): Promise<SelfHealRetryResult<T>> {
  const matched = findAnthropicServerToolError(opts.error);
  if (!matched) return { healed: false };

  const stripped = stripAnthropicServerTools((opts.params as any)?.tools);
  if (!stripped) return { healed: false };

  const upstream = matched.upstreamPrefix ?? "unknown";
  logger.warn(
    "Gateway upstream rejected Anthropic server-side tools (provider capability divergence), stripping them and retrying",
    {
      modelId: opts.gatewayId,
      upstream,
      reason: matched.reason,
      strippedTools: stripped.strippedNames,
    },
  );
  logError({
    errorName: "AnthropicServerToolDivergence",
    errorMessage: `Gateway upstream (${upstream}) failed on Anthropic server-side tools for ${opts.gatewayId}: ${matched.matchedMessage}`,
    errorCode: "anthropic_server_tool_divergence",
    context: {
      modelId: opts.gatewayId,
      upstream,
      reason: matched.reason,
      strippedTools: stripped.strippedNames,
    },
  });

  const scrubbedPrompt = scrubServerToolParts(
    (opts.params as any)?.prompt,
    stripped.strippedNames,
  );
  const retryParams = {
    ...(isRecord(opts.params) ? opts.params : {}),
    tools: stripped.tools,
    ...(Array.isArray(scrubbedPrompt) ? { prompt: scrubbedPrompt } : {}),
  };
  return { healed: true, result: await opts.retry(retryParams) };
}

function gatewayFallbackMiddleware(
  directModelId: string,
  gatewayId: string,
  gatewayModel: WrappableModel,
): LanguageModelMiddleware {
  return {
    specificationVersion: "v3" as const,
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

        const strippedServerTools = await retryWithStrippedServerTools<
          Awaited<ReturnType<typeof doGenerate>>
        >({
          error,
          gatewayId,
          params,
          retry: (retryParams) =>
            gatewayModel.doGenerate(retryParams) as ReturnType<typeof doGenerate>,
        });
        if (strippedServerTools.healed) return strippedServerTools.result;

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

        const strippedServerTools = await retryWithStrippedServerTools<
          Awaited<ReturnType<typeof doStream>>
        >({
          error,
          gatewayId,
          params,
          retry: (retryParams) =>
            gatewayModel.doStream(retryParams) as ReturnType<typeof doStream>,
        });
        if (strippedServerTools.healed) return strippedServerTools.result;

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
 *    thinking-mode mismatches and capability-divergence errors, and falls
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
