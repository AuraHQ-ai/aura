import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import {
  ModelCapabilities as ModelCapabilitiesSchema,
  type ModelCapabilities as StoredModelCapabilities,
  modelCatalog,
  modelCatalogSelections,
  modelPricing,
} from "@aura/db/schema";
import { db } from "../db/client.js";
import { logger } from "./logger.js";

export const MODEL_CATEGORIES = [
  "main",
  "fast",
  "embedding",
  "escalation",
] as const;

export type ModelCategory = (typeof MODEL_CATEGORIES)[number];

function isModelCategory(value: unknown): value is ModelCategory {
  return typeof value === "string" && MODEL_CATEGORIES.includes(value as ModelCategory);
}

export interface ModelOption {
  value: string;
  label: string;
}

export interface ModelCatalogItem {
  value: string;
  label: string;
  provider: string;
  type: string;
  enabledCategories: ModelCategory[];
  defaultCategories: ModelCategory[];
  lastSyncedAt: string | null;
}

export interface ModelCatalogResponse {
  main: ModelOption[];
  fast: ModelOption[];
  embedding: ModelOption[];
  escalation: ModelOption[];
  defaults: Partial<Record<ModelCategory, string>>;
  catalog: ModelCatalogItem[];
  lastSyncedAt: string | null;
}

export interface GatewayModel {
  id: string;
  owned_by?: string;
  name?: string;
  description?: string;
  type?: string;
  context_window?: number;
  max_tokens?: number;
  tags?: string[];
  pricing?: Record<string, string | number | null>;
  [key: string]: unknown;
}

interface SyncResult {
  syncedAt: Date;
  modelCount: number;
}

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const DEFAULT_WORKSPACE_ID = "default";

function providerFromModelId(modelId: string): string {
  return modelId.split("/")[0] ?? "unknown";
}

function getGatewayModelTags(model: GatewayModel): string[] {
  return Array.isArray(model.tags)
    ? model.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
}

function hasReasoningTag(tags: string[]): boolean {
  return tags.includes("reasoning");
}

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

function inferStaticModelCapabilities(
  gatewayModel: GatewayModel,
): StoredModelCapabilities | null {
  const tags = getGatewayModelTags(gatewayModel);
  if (!hasReasoningTag(tags)) return null;

  switch (providerFromModelId(gatewayModel.id)) {
    case "openai":
      return { provider: "openai", reasoningEffort: "medium" };
    case "google":
      return { provider: "google", thinkingBudget: "dynamic" };
    case "xai":
      return { provider: "xai", reasoningEffort: "low" };
    default:
      return null;
  }
}

async function probeAnthropicThinkingMode(
  modelId: string,
): Promise<StoredModelCapabilities | null> {
  const [{ generateText }, { gateway }] = await Promise.all([
    import("ai"),
    import("@ai-sdk/gateway"),
  ]);

  try {
    await generateText({
      model: gateway(modelId),
      prompt: "ok",
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 1024 },
        },
      },
      maxOutputTokens: 10,
    });
    return { provider: "anthropic", thinkingMode: "enabled" };
  } catch (error) {
    if (errorIncludes(error, "\"thinking.type.enabled\" is not supported")) {
      return { provider: "anthropic", thinkingMode: "adaptive" };
    }
    if (errorIncludes(error, "adaptive thinking is not supported on this model")) {
      return { provider: "anthropic", thinkingMode: "enabled" };
    }

    logger.warn("Anthropic thinking-mode probe failed", {
      modelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function seedModelCapabilitiesForSyncedModels(
  gatewayModels: GatewayModel[],
  workspaceId: string,
): Promise<void> {
  const modelIds = gatewayModels.map((model) => model.id);
  if (modelIds.length === 0) return;

  const gatewayModelById = new Map(
    gatewayModels.map((model) => [model.id, model]),
  );
  const rows = await db
    .select({
      modelId: modelCatalog.modelId,
      capabilities: modelCatalog.capabilities,
    })
    .from(modelCatalog)
    .where(
      and(
        eq(modelCatalog.workspaceId, workspaceId),
        inArray(modelCatalog.modelId, modelIds),
        isNull(modelCatalog.capabilities),
      ),
    );

  for (const row of rows) {
    const gatewayModel = gatewayModelById.get(row.modelId);
    if (!gatewayModel) continue;

    const tags = getGatewayModelTags(gatewayModel);
    if (!hasReasoningTag(tags)) continue;

    let capabilities: StoredModelCapabilities | null = null;
    if (providerFromModelId(row.modelId) === "anthropic") {
      capabilities = await probeAnthropicThinkingMode(row.modelId);
    } else {
      capabilities = inferStaticModelCapabilities(gatewayModel);
    }

    if (!capabilities) continue;

    await updateModelCapabilities(row.modelId, capabilities, workspaceId);
    logger.info("Seeded model capabilities from catalog refresh", {
      workspaceId,
      modelId: row.modelId,
      capabilities,
    });
  }
}

function normalizePricingKey(key: string): string {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (normalized === "cached_input" || normalized === "input_cache_read") {
    return "cache_read";
  }
  if (
    normalized === "cache_creation" ||
    normalized === "cache_write_input" ||
    normalized === "input_cache_write"
  ) {
    return "cache_write";
  }
  if (normalized === "reasoning_output") {
    return "reasoning";
  }
  return normalized;
}

function toPricePerMillion(
  rawPrice: string | number | null | undefined,
): string | null {
  if (rawPrice == null) return null;
  const numeric = Number(rawPrice);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return (numeric * 1_000_000).toString();
}

export async function fetchGatewayModels(): Promise<GatewayModel[]> {
  const response = await fetch(GATEWAY_MODELS_URL);
  if (!response.ok) {
    throw new Error(`Gateway models fetch failed: ${response.status}`);
  }

  const payload = await response.json() as { data?: GatewayModel[] };
  if (!Array.isArray(payload.data)) {
    throw new Error("Gateway models payload missing data array");
  }

  return payload.data.filter((model): model is GatewayModel => typeof model.id === "string");
}

export async function syncModelCatalogFromGateway(
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<SyncResult> {
  const gatewayModels = await fetchGatewayModels();
  const syncedAt = new Date();

  if (gatewayModels.length > 0) {
    await db
      .insert(modelCatalog)
      .values(
        gatewayModels.map((gatewayModel) => ({
          workspaceId,
          modelId: gatewayModel.id,
          provider: providerFromModelId(gatewayModel.id),
          name: gatewayModel.name ?? gatewayModel.id,
          description:
            typeof gatewayModel.description === "string"
              ? gatewayModel.description
              : null,
          type: gatewayModel.type ?? "unknown",
          contextWindow:
            typeof gatewayModel.context_window === "number"
              ? gatewayModel.context_window
              : null,
          maxTokens:
            typeof gatewayModel.max_tokens === "number"
              ? gatewayModel.max_tokens
              : null,
          tags: getGatewayModelTags(gatewayModel),
          capabilities: inferStaticModelCapabilities(gatewayModel),
          rawPricing: gatewayModel.pricing ?? null,
          rawPayload: gatewayModel,
          lastSyncedAt: syncedAt,
          updatedAt: syncedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [modelCatalog.workspaceId, modelCatalog.modelId],
        set: {
          provider: sql`excluded.provider`,
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          type: sql`excluded.type`,
          contextWindow: sql`excluded.context_window`,
          maxTokens: sql`excluded.max_tokens`,
          tags: sql`excluded.tags`,
          rawPricing: sql`excluded.raw_pricing`,
          rawPayload: sql`excluded.raw_payload`,
          lastSyncedAt: sql`excluded.last_synced_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  for (const modelId of gatewayModels.map((model) => model.id)) {
    capabilityCache.delete(`${workspaceId}::${modelId}`);
  }
  await seedModelCapabilitiesForSyncedModels(gatewayModels, workspaceId);

  const modelIds = gatewayModels.map((model) => model.id);
  const activeRows = modelIds.length
    ? await db
        .select({
          id: modelPricing.id,
          modelId: modelPricing.modelId,
          tokenType: modelPricing.tokenType,
          pricePerMillion: modelPricing.pricePerMillion,
        })
        .from(modelPricing)
        .where(
          and(
            eq(modelPricing.workspaceId, workspaceId),
            inArray(modelPricing.modelId, modelIds),
            isNull(modelPricing.effectiveUntil),
          ),
        )
    : [];

  const activeByKey = new Map(
    activeRows.map((row) => [`${row.modelId}:${row.tokenType}`, row]),
  );

  for (const model of gatewayModels) {
    const pricingEntries = Object.entries(model.pricing ?? {})
      .map(([key, value]) => ({
        tokenType: normalizePricingKey(key),
        pricePerMillion: toPricePerMillion(value),
      }))
      .filter(
        (entry): entry is { tokenType: string; pricePerMillion: string } =>
          entry.pricePerMillion !== null,
      );

    const seenTokenTypes = new Set(pricingEntries.map((entry) => entry.tokenType));

    for (const entry of pricingEntries) {
      const existing = activeByKey.get(`${model.id}:${entry.tokenType}`);
      if (existing && Number(existing.pricePerMillion) === Number(entry.pricePerMillion)) {
        continue;
      }

      if (existing) {
        await db
          .update(modelPricing)
          .set({ effectiveUntil: syncedAt })
          .where(eq(modelPricing.id, existing.id));
      }

      await db.insert(modelPricing).values({
        workspaceId,
        modelId: model.id,
        tokenType: entry.tokenType,
        pricePerMillion: entry.pricePerMillion,
        effectiveFrom: syncedAt,
        effectiveUntil: null,
        createdAt: syncedAt,
      });
    }

    const staleRows = activeRows.filter(
      (row) => row.modelId === model.id && !seenTokenTypes.has(row.tokenType),
    );

    for (const staleRow of staleRows) {
      await db
        .update(modelPricing)
        .set({ effectiveUntil: syncedAt })
        .where(eq(modelPricing.id, staleRow.id));
    }
  }

  logger.info("Synced model catalog from gateway", {
    workspaceId,
    modelCount: gatewayModels.length,
    syncedAt: syncedAt.toISOString(),
  });

  return {
    syncedAt,
    modelCount: gatewayModels.length,
  };
}

export async function getModelCatalogResponse(
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<ModelCatalogResponse> {
  const rows = await db
    .select({
      modelId: modelCatalog.modelId,
      name: modelCatalog.name,
      provider: modelCatalog.provider,
      type: modelCatalog.type,
      lastSyncedAt: modelCatalog.lastSyncedAt,
      selectionCategory: modelCatalogSelections.category,
      selectionEnabled: modelCatalogSelections.enabled,
      selectionDefault: modelCatalogSelections.isDefault,
    })
    .from(modelCatalog)
    .leftJoin(
      modelCatalogSelections,
      and(
        eq(modelCatalogSelections.workspaceId, modelCatalog.workspaceId),
        eq(modelCatalogSelections.modelId, modelCatalog.modelId),
      ),
    )
    .where(eq(modelCatalog.workspaceId, workspaceId))
    .orderBy(asc(modelCatalog.provider), asc(modelCatalog.name));

  const catalogByModelId = new Map<string, ModelCatalogItem>();
  const grouped: Record<ModelCategory, ModelOption[]> = {
    main: [],
    fast: [],
    embedding: [],
    escalation: [],
  };
  const defaults: Partial<Record<ModelCategory, string>> = {};
  let lastSyncedAt: string | null = null;

  for (const row of rows) {
    const item =
      catalogByModelId.get(row.modelId) ??
      {
        value: row.modelId,
        label: row.name,
        provider: row.provider,
        type: row.type,
        enabledCategories: [],
        defaultCategories: [],
        lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      };

    if (isModelCategory(row.selectionCategory) && row.selectionEnabled) {
      const category = row.selectionCategory;

      if (!item.enabledCategories.includes(category)) {
        item.enabledCategories.push(category);
      }

      const option = { value: row.modelId, label: row.name };
      grouped[category].push(option);

      if (row.selectionDefault) {
        if (!item.defaultCategories.includes(category)) {
          item.defaultCategories.push(category);
        }
        defaults[category] = row.modelId;
      }
    }

    if (item.lastSyncedAt && (!lastSyncedAt || item.lastSyncedAt > lastSyncedAt)) {
      lastSyncedAt = item.lastSyncedAt;
    }

    catalogByModelId.set(row.modelId, item);
  }

  for (const item of catalogByModelId.values()) {
    if (item.enabledCategories.length > 0) continue;

    const fallbackCategory: ModelCategory =
      item.type === "embedding" ? "embedding" : "main";
    grouped[fallbackCategory].push({ value: item.value, label: item.label });
  }

  for (const category of MODEL_CATEGORIES) {
    const deduped = new Map<string, ModelOption>();
    for (const option of grouped[category]) {
      deduped.set(option.value, option);
    }
    grouped[category] = Array.from(deduped.values());
  }

  for (const category of MODEL_CATEGORIES) {
    if (!defaults[category]) {
      defaults[category] = grouped[category][0]?.value;
    }
  }

  return {
    main: grouped.main,
    fast: grouped.fast,
    embedding: grouped.embedding,
    escalation: grouped.escalation,
    defaults,
    catalog: Array.from(catalogByModelId.values()),
    lastSyncedAt,
  };
}

export async function getDefaultModelId(
  category: ModelCategory,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<string | null> {
  const catalog = await getModelCatalogResponse(workspaceId);
  return catalog.defaults[category] ?? null;
}

// ── Model capabilities (from gateway tags + persisted provider config) ───────
// The Vercel AI Gateway returns a `tags` array per model. We treat the
// presence of `"reasoning"` as the signal that a model supports thinking —
// this is the same source of truth used across repos (mako/mono). No model
// ID parsing.

export interface ModelCatalogCapabilities {
  found: boolean;
  supportsThinking: boolean;
  tags: string[];
  capabilities: StoredModelCapabilities | null;
}

const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;
const capabilityCache = new Map<string, { value: ModelCatalogCapabilities; expiresAt: number }>();
const MISSING_CAPABILITIES: ModelCatalogCapabilities = {
  found: false,
  supportsThinking: false,
  tags: [],
  capabilities: null,
};

export async function getModelCapabilities(
  modelId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<ModelCatalogCapabilities> {
  const cacheKey = `${workspaceId}::${modelId}`;
  const cached = capabilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [row] = await db
    .select({
      tags: modelCatalog.tags,
      capabilities: modelCatalog.capabilities,
    })
    .from(modelCatalog)
    .where(
      and(
        eq(modelCatalog.workspaceId, workspaceId),
        eq(modelCatalog.modelId, modelId),
      ),
    )
    .limit(1);

  const tags = Array.isArray(row?.tags) ? row!.tags : [];
  let capabilities: StoredModelCapabilities | null = null;
  if (row?.capabilities != null) {
    const parsed = ModelCapabilitiesSchema.safeParse(row.capabilities);
    if (parsed.success) {
      capabilities = parsed.data;
    } else {
      logger.warn("getModelCapabilities: invalid persisted capabilities", {
        modelId,
        workspaceId,
        issues: parsed.error.issues,
      });
    }
  }

  const value: ModelCatalogCapabilities = {
    found: Boolean(row),
    supportsThinking: tags.includes("reasoning"),
    tags,
    capabilities,
  };

  if (!row) {
    logger.warn("getModelCapabilities: model not in catalog", {
      modelId,
      workspaceId,
    });
    capabilityCache.set(cacheKey, {
      value: MISSING_CAPABILITIES,
      expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS,
    });
    return MISSING_CAPABILITIES;
  }

  capabilityCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS,
  });
  return value;
}

export async function updateModelCapabilities(
  modelId: string,
  capabilities: StoredModelCapabilities,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<boolean> {
  const parsed = ModelCapabilitiesSchema.parse(capabilities);
  const [updated] = await db
    .update(modelCatalog)
    .set({
      capabilities: parsed,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(modelCatalog.workspaceId, workspaceId),
        eq(modelCatalog.modelId, modelId),
      ),
    )
    .returning({ modelId: modelCatalog.modelId });

  capabilityCache.delete(`${workspaceId}::${modelId}`);

  if (!updated) {
    logger.warn("updateModelCapabilities: model not in catalog", {
      modelId,
      workspaceId,
      capabilities: parsed,
    });
    return false;
  }

  return true;
}

