import crypto from "node:crypto";
import { getSetting, setSetting } from "./settings.js";
import { logger } from "./logger.js";

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

export function maskCredential(value: string): string {
  if (value.length <= 12) return "••••••••";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
