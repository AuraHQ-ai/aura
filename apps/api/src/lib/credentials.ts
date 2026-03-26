import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { getSetting, setSetting } from "./settings.js";
import { logger } from "./logger.js";
import { db } from "../db/client.js";
import { credentials } from "@aura/db/schema";

const ALGORITHM = "aes-256-gcm";
const KEY_ENV = "CREDENTIALS_KEY";
const DB_PREFIX = "credential:";

const ENV_FALLBACKS: Record<string, string[]> = {
  github_token: ["GH_TOKEN", "GITHUB_TOKEN"],
};

function getKeyBuffer(): Buffer | null {
  const hex = process.env[KEY_ENV];
  if (!hex) return null;
  return Buffer.from(hex, "hex");
}

export function encryptCredential(plaintext: string): string {
  const key = getKeyBuffer();
  if (!key) throw new Error(`${KEY_ENV} is not configured`);

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptCredential(ciphertext: string): string {
  const key = getKeyBuffer();
  if (!key) throw new Error(`${KEY_ENV} is not configured`);

  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(":");
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Invalid ciphertext format");
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

export async function getCredential(key: string): Promise<string | null> {
  if (getKeyBuffer()) {
    try {
      const raw = await getSetting(`${DB_PREFIX}${key}`);
      if (raw) return decryptCredential(raw);
    } catch (error) {
      logger.error("Failed to read credential from DB, falling back to env", {
        key,
        error,
      });
    }
  }

  const envNames = ENV_FALLBACKS[key];
  if (envNames) {
    for (const name of envNames) {
      if (process.env[name]) return process.env[name]!;
    }
  }

  return null;
}

export async function setCredential(
  key: string,
  value: string,
  updatedBy?: string,
): Promise<void> {
  const encrypted = encryptCredential(value);
  await setSetting(`${DB_PREFIX}${key}`, encrypted, updatedBy);
  logger.info("Credential stored", { key, updatedBy });
}

/**
 * Resolve a credential value by name from the credentials table.
 * Returns null if not found or decryption fails.
 */
export async function resolveCredentialValue(name: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ value: credentials.value })
      .from(credentials)
      .where(eq(credentials.name, name))
      .limit(1);
    if (!row) return null;
    return decryptCredential(row.value);
  } catch (e: any) {
    logger.warn("resolveCredentialValue failed", { name, error: e.message });
    return null;
  }
}

export function maskCredential(value: string): string {
  if (value.length <= 12) return "••••••••";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
