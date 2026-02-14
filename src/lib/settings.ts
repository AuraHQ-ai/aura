import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { settings } from "../db/schema.js";
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
