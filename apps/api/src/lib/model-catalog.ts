import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import {
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

interface GatewayModel {
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

async function fetchGatewayModels(): Promise<GatewayModel[]> {
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
          tags: Array.isArray(gatewayModel.tags)
            ? gatewayModel.tags.filter(
                (tag): tag is string => typeof tag === "string",
              )
            : null,
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

    if (row.selectionCategory && row.selectionEnabled) {
      if (!item.enabledCategories.includes(row.selectionCategory)) {
        item.enabledCategories.push(row.selectionCategory);
      }

      const option = { value: row.modelId, label: row.name };
      grouped[row.selectionCategory].push(option);

      if (row.selectionDefault) {
        if (!item.defaultCategories.includes(row.selectionCategory)) {
          item.defaultCategories.push(row.selectionCategory);
        }
        defaults[row.selectionCategory] = row.modelId;
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

// ── Model capabilities (from gateway tags) ───────────────────────────────────
// The Vercel AI Gateway returns a `tags` array per model. We treat the
// presence of `"reasoning"` as the signal that a model supports thinking —
// this is the same source of truth used across repos (mako/mono). No model
// ID parsing.

export interface ModelCapabilities {
  supportsThinking: boolean;
  tags: string[];
}

const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;
const capabilityCache = new Map<string, { value: ModelCapabilities; expiresAt: number }>();
const MISSING_CAPABILITIES: ModelCapabilities = { supportsThinking: false, tags: [] };

export async function getModelCapabilities(
  modelId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<ModelCapabilities> {
  const cacheKey = `${workspaceId}::${modelId}`;
  const cached = capabilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [row] = await db
    .select({ tags: modelCatalog.tags })
    .from(modelCatalog)
    .where(
      and(
        eq(modelCatalog.workspaceId, workspaceId),
        eq(modelCatalog.modelId, modelId),
      ),
    )
    .limit(1);

  const tags = Array.isArray(row?.tags) ? row!.tags : [];
  const value: ModelCapabilities = {
    supportsThinking: tags.includes("reasoning"),
    tags,
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

