import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { settings } from "@aura/db/schema";
import { logger } from "./logger.js";

/**
 * Read a single setting by key. Returns null if not set.
 */
export async function getSetting(key: string): Promise<string | null> {
  try {
    const rows = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);

    return rows[0]?.value ?? null;
  } catch (error) {
    logger.error("Failed to read setting", { key, error });
    return null;
  }
}

/**
 * Upsert a setting. Creates or updates the key-value pair.
 */
export async function setSetting(
  key: string,
  value: string,
  updatedBy?: string,
): Promise<void> {
  try {
    await db
      .insert(settings)
      .values({ key, value, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedBy, updatedAt: new Date() },
      });

    logger.info("Setting updated", { key, value, updatedBy });
  } catch (error) {
    logger.error("Failed to write setting", { key, value, error });
    throw error;
  }
}

/**
 * Read all settings as a key-value record.
 */
export async function getAllSettings(): Promise<Record<string, string>> {
  try {
    const rows = await db.select().from(settings);
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  } catch (error) {
    logger.error("Failed to read all settings", { error });
    return {};
  }
}

// ── JSON settings (with short TTL cache) ────────────────────────────────────

const jsonSettingsCache = new Map<string, { value: unknown; expiresAt: number }>();
const JSON_CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Read a setting as parsed JSON. Cached for 60s to avoid DB hits on hot paths.
 * Returns the parsed value, or `fallback` if the key is unset or invalid JSON.
 */
export async function getSettingJSON<T = unknown>(
  key: string,
  fallback: T | null = null,
): Promise<T | null> {
  const now = Date.now();
  const cached = jsonSettingsCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value as T;

  const raw = await getSetting(key);
  if (raw === null) {
    jsonSettingsCache.set(key, { value: fallback, expiresAt: now + JSON_CACHE_TTL_MS });
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as T;
    jsonSettingsCache.set(key, { value: parsed, expiresAt: now + JSON_CACHE_TTL_MS });
    return parsed;
  } catch {
    logger.warn("Failed to parse JSON setting", { key, raw });
    jsonSettingsCache.set(key, { value: fallback, expiresAt: now + JSON_CACHE_TTL_MS });
    return fallback;
  }
}
