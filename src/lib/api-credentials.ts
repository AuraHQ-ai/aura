/**
 * Encrypted credential storage with per-user access control.
 *
 * Uses AES-256-GCM (same pattern as credentials.ts) with row-level
 * ownership, grant-based sharing, and full audit logging.
 */
import crypto from "node:crypto";
import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  credentials,
  credentialGrants,
  credentialAuditLog,
} from "../db/schema.js";
import { logger } from "./logger.js";

// ── Encryption ─────────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const KEY_ENV = "CREDENTIALS_KEY";
const NAME_REGEX = /^[a-z][a-z0-9_]{1,62}$/;

function getKeyBuffer(): Buffer {
  const hex = process.env[KEY_ENV];
  if (!hex) throw new Error(`${KEY_ENV} is not configured`);
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error(
      `${KEY_ENV} must be exactly 32 bytes (64 hex chars), got ${buf.length}`,
    );
  }
  return buf;
}

function encrypt(plaintext: string): string {
  const key = getKeyBuffer();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(ciphertext: string): string {
  const key = getKeyBuffer();
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

// ── Helpers ────────────────────────────────────────────────────────────────

function validateName(name: string): void {
  if (!NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid credential name "${name}". Must match ${NAME_REGEX}`,
    );
  }
}

async function audit(
  credentialId: string | null,
  credentialName: string,
  accessedBy: string,
  action: string,
  context?: string,
): Promise<void> {
  try {
    await db.insert(credentialAuditLog).values({
      credentialId,
      credentialName,
      accessedBy,
      action,
      context: context ?? null,
    });
  } catch (err) {
    logger.error("Failed to write credential audit log", { err });
  }
}

type Permission = "read" | "write" | "admin";

/**
 * Check whether `userId` has at least `requiredPermission` on a credential.
 * Owner always has all permissions. Grants are checked for non-owners.
 */
async function hasPermission(
  credentialOwnerId: string,
  credentialId: string,
  userId: string,
  requiredPermission: Permission,
): Promise<boolean> {
  // Owner has all permissions
  if (userId === credentialOwnerId) return true;

  const grant = await db
    .select()
    .from(credentialGrants)
    .where(
      and(
        eq(credentialGrants.credentialId, credentialId),
        eq(credentialGrants.granteeId, userId),
        isNull(credentialGrants.revokedAt),
      ),
    )
    .limit(1);

  if (!grant.length) return false;

  const grantPerm = grant[0].permission;
  const hierarchy: Permission[] = ["read", "write", "admin"];
  return (
    hierarchy.indexOf(grantPerm as Permission) >=
    hierarchy.indexOf(requiredPermission)
  );
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Store (create or update) an encrypted credential.
 */
export async function storeApiCredential(
  name: string,
  value: string,
  ownerId: string,
  opts?: { expiresAt?: Date },
): Promise<{ id: string; created: boolean }> {
  validateName(name);
  const encryptedValue = encrypt(value);

  // UPSERT — avoids race condition between concurrent insert attempts
  const [row] = await db
    .insert(credentials)
    .values({
      ownerId,
      name,
      value: encryptedValue,
      expiresAt: opts?.expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [credentials.ownerId, credentials.name],
      set: {
        value: encryptedValue,
        expiresAt: opts?.expiresAt ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: credentials.id });

  // Determine if this was a create or update by checking updated_at vs created_at
  const [check] = await db
    .select({ createdAt: credentials.createdAt, updatedAt: credentials.updatedAt })
    .from(credentials)
    .where(eq(credentials.id, row.id))
    .limit(1);

  const created = check.createdAt.getTime() === check.updatedAt.getTime();
  await audit(row.id, name, ownerId, created ? "create" : "update");
  return { id: row.id, created };
}

/**
 * Get a decrypted credential by name. Checks ownership or grant permission.
 * Records an audit log entry with the intent.
 */
export async function getApiCredential(
  name: string,
  ownerId: string,
  requestingUserId: string,
  intent?: string,
): Promise<string | null> {
  validateName(name);

  const rows = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.ownerId, ownerId), eq(credentials.name, name)))
    .limit(1);

  if (!rows.length) return null;

  const cred = rows[0];

  // Check expiry — null the value, audit, and notify owner
  if (cred.expiresAt && cred.expiresAt < new Date()) {
    await audit(cred.id, name, requestingUserId, "read", "expired");

    // Best-effort DM to credential owner about expiry
    try {
      const { WebClient } = await import("@slack/web-api");
      const botToken = process.env.SLACK_BOT_TOKEN;
      if (botToken && cred.ownerId !== "system") {
        const client = new WebClient(botToken);
        await client.chat.postMessage({
          channel: cred.ownerId,
          text: `⚠️ Your credential *${name}* has expired (was set to expire ${cred.expiresAt.toISOString().split("T")[0]}). Please rotate it in your App Home settings.`,
        });
      }
    } catch {
      // Non-critical — don't fail the read operation
    }

    return null;
  }

  // Check permission
  const allowed = await hasPermission(
    cred.ownerId,
    cred.id,
    requestingUserId,
    "read",
  );
  if (!allowed) {
    await audit(cred.id, name, requestingUserId, "read", "denied");
    throw new Error(
      `Access denied: ${requestingUserId} cannot read credential "${name}"`,
    );
  }

  await audit(cred.id, name, requestingUserId, "read", intent);
  return decrypt(cred.value);
}

/**
 * Get a credential for job/system use. Uses "system" as the requesting user
 * and always has access (bypasses grants).
 */
export async function getJobApiCredential(
  name: string,
  ownerId: string,
  jobContext?: string,
): Promise<string | null> {
  validateName(name);

  const rows = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.ownerId, ownerId), eq(credentials.name, name)))
    .limit(1);

  if (!rows.length) return null;

  const cred = rows[0];

  if (cred.expiresAt && cred.expiresAt < new Date()) return null;

  await audit(cred.id, name, "system", "use", jobContext ?? "job execution");
  return decrypt(cred.value);
}

/**
 * List credentials for an owner (metadata only, no decryption).
 */
export async function listApiCredentials(
  ownerId: string,
): Promise<
  Array<{
    id: string;
    name: string;
    keyVersion: number;
    expiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>
> {
  return db
    .select({
      id: credentials.id,
      name: credentials.name,
      keyVersion: credentials.keyVersion,
      expiresAt: credentials.expiresAt,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt,
    })
    .from(credentials)
    .where(eq(credentials.ownerId, ownerId));
}

/**
 * Delete a credential. Only the owner or an admin grantee can delete.
 */
export async function deleteApiCredential(
  name: string,
  ownerId: string,
  requestingUserId: string,
): Promise<boolean> {
  validateName(name);

  const rows = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.ownerId, ownerId), eq(credentials.name, name)))
    .limit(1);

  if (!rows.length) return false;

  const cred = rows[0];
  const allowed = await hasPermission(
    cred.ownerId,
    cred.id,
    requestingUserId,
    "admin",
  );
  if (!allowed) {
    await audit(cred.id, name, requestingUserId, "delete", "denied");
    throw new Error(
      `Access denied: ${requestingUserId} cannot delete credential "${name}"`,
    );
  }

  await db.delete(credentials).where(eq(credentials.id, cred.id));
  await audit(null, name, requestingUserId, "delete");
  return true;
}

/**
 * Grant access to a credential. Uses ON CONFLICT DO UPDATE to upsert.
 * Only the owner or an admin grantee can grant.
 */
export async function grantApiCredentialAccess(
  name: string,
  ownerId: string,
  granteeId: string,
  permission: Permission,
  grantedBy: string,
): Promise<void> {
  validateName(name);

  const rows = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.ownerId, ownerId), eq(credentials.name, name)))
    .limit(1);

  if (!rows.length) throw new Error(`Credential "${name}" not found`);

  const cred = rows[0];
  const allowed = await hasPermission(
    cred.ownerId,
    cred.id,
    grantedBy,
    "admin",
  );
  if (!allowed) {
    await audit(cred.id, name, grantedBy, "grant", "denied");
    throw new Error(
      `Access denied: ${grantedBy} cannot grant access to "${name}"`,
    );
  }

  await db
    .insert(credentialGrants)
    .values({
      credentialId: cred.id,
      granteeId,
      permission,
      grantedBy,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: [credentialGrants.credentialId, credentialGrants.granteeId],
      set: {
        permission,
        grantedBy,
        grantedAt: new Date(),
        revokedAt: null,
      },
    });

  await audit(
    cred.id,
    name,
    grantedBy,
    "grant",
    `${permission} → ${granteeId}`,
  );
}

/**
 * Revoke access (soft revoke via revoked_at).
 */
export async function revokeApiCredentialAccess(
  name: string,
  ownerId: string,
  granteeId: string,
  revokedBy: string,
): Promise<boolean> {
  validateName(name);

  const rows = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.ownerId, ownerId), eq(credentials.name, name)))
    .limit(1);

  if (!rows.length) return false;

  const cred = rows[0];
  const allowed = await hasPermission(
    cred.ownerId,
    cred.id,
    revokedBy,
    "admin",
  );
  if (!allowed) {
    await audit(cred.id, name, revokedBy, "revoke", "denied");
    throw new Error(
      `Access denied: ${revokedBy} cannot revoke access to "${name}"`,
    );
  }

  await db
    .update(credentialGrants)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(credentialGrants.credentialId, cred.id),
        eq(credentialGrants.granteeId, granteeId),
        isNull(credentialGrants.revokedAt),
      ),
    );

  await audit(cred.id, name, revokedBy, "revoke", `revoked ${granteeId}`);
  return true;
}

/**
 * Wrapper that fetches a credential and passes it to a callback,
 * scrubbing the credential value from any errors thrown.
 */
export async function withApiCredential<T>(
  name: string,
  ownerId: string,
  requestingUserId: string,
  intent: string,
  fn: (value: string) => Promise<T>,
): Promise<T> {
  const value = await getApiCredential(
    name,
    ownerId,
    requestingUserId,
    intent,
  );
  if (!value) {
    throw new Error(`Credential "${name}" not found or expired`);
  }

  try {
    return await fn(value);
  } catch (err) {
    // Scrub the credential value from any error messages
    const message = err instanceof Error ? err.message : String(err);
    const scrubbed = message.replaceAll(value, "[REDACTED]");
    const safeError = new Error(scrubbed);
    if (err instanceof Error)
      safeError.stack = err.stack?.replaceAll(value, "[REDACTED]");
    throw safeError;
  }
}

/**
 * Mask a credential value for display (first 8 chars + last 4).
 */
export function maskApiCredential(value: string): string {
  if (value.length <= 12) return "••••••••";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

/**
 * ── Key Rotation Procedure ─────────────────────────────────────────────────
 *
 * To rotate the CREDENTIALS_KEY (master encryption key):
 *
 * 1. Generate a new 32-byte key:
 *    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * 2. Set the new key in environment as CREDENTIALS_KEY_NEW alongside the old
 *    CREDENTIALS_KEY.
 *
 * 3. Run the re-encryption migration:
 *    - Read each credential row
 *    - Decrypt with old key (CREDENTIALS_KEY)
 *    - Re-encrypt with new key (CREDENTIALS_KEY_NEW)
 *    - Update the row with new ciphertext and increment key_version
 *
 * 4. Once all rows are re-encrypted, swap CREDENTIALS_KEY_NEW → CREDENTIALS_KEY
 *    and remove the old key.
 *
 * 5. Verify by reading a credential and confirming decryption succeeds.
 *
 * To rotate individual API credentials:
 *
 * 1. User generates a new API key from the provider.
 * 2. User updates the credential via App Home → overflow menu → Update.
 * 3. The old value is overwritten (UPSERT) and an audit entry is logged.
 * 4. Optionally set a new expiration date.
 * 5. All grants remain valid — grantees automatically get the new value.
 */
