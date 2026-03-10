import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_ENV = "CREDENTIALS_KEY";

function getKeyBuffer(): Buffer | null {
  const hex = process.env[KEY_ENV];
  if (!hex) return null;
  return Buffer.from(hex, "hex");
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

export function maskCredential(value: string): string {
  if (value.length <= 12) return "••••••••";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
