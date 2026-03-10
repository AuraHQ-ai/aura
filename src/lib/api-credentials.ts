import { eq, and, or, isNull, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  credentials,
  credentialGrants,
  credentialAuditLog,
  userProfiles,
  type Credential,
} from "../db/schema.js";
import { encryptCredential, decryptCredential } from "./credentials.js";
import { logger } from "./logger.js";

const NAME_RE = /^[a-z][a-z0-9_]{1,62}$/;
const KEY_ENV = "CREDENTIALS_KEY";

function validateKey(): void {
  const hex = process.env[KEY_ENV];
  if (!hex || Buffer.from(hex, "hex").length !== 32) {
    throw new Error(
      `${KEY_ENV} must be a 64-character hex string (32 bytes)`,
    );
  }
}

function validateName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `Invalid credential name "${name}": must match /^[a-z][a-z0-9_]{1,62}$/`,
    );
  }
}

type AuditAction =
  | "read"
  | "write"
  | "create"
  | "update"
  | "delete"
  | "grant"
  | "revoke"
  | "use"
  | "expired_access_attempt";

export type AuthScheme = "bearer" | "basic" | "header" | "query" | "oauth_client" | "google_service_account";

async function audit(
  credentialId: string | null,
  credentialName: string,
  accessedBy: string,
  action: AuditAction,
  context?: string,
): Promise<void> {
  try {
    await db.insert(credentialAuditLog).values({
      credentialId,
      credentialName,
      accessedBy,
      action,
      context,
    });
  } catch (error) {
    logger.error("Failed to write credential audit log", {
      credentialName,
      accessedBy,
      action,
      error,
    });
  }
}

async function notifyOwnerExpired(
  ownerId: string,
  credentialName: string,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  const { WebClient } = await import("@slack/web-api");
  const client = new WebClient(token);
  const dm = await client.conversations.open({ users: ownerId });
  if (dm.channel?.id) {
    await client.chat.postMessage({
      channel: dm.channel.id,
      text: `Your credential *${credentialName}* has expired. Please update or rotate it in the App Home.`,
    });
  }
}

export async function hasPermission(
  credentialOwnerId: string,
  credentialId: string,
  userId: string,
  requiredPermission: "read" | "write" | "admin",
): Promise<boolean> {
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
  const hierarchy: Array<"read" | "write" | "admin"> = ["read", "write", "admin"];
  return hierarchy.indexOf(grantPerm as typeof requiredPermission) >= hierarchy.indexOf(requiredPermission);
}

export async function storeApiCredential(
  ownerId: string,
  name: string,
  plaintext: string,
  expiresAt?: Date,
  authScheme: AuthScheme = "bearer",
): Promise<Credential> {
  validateKey();
  validateName(name);

  if (authScheme === "oauth_client") {
    try {
      const parsed = JSON.parse(plaintext);
      if (!parsed.client_id || !parsed.client_secret || !parsed.token_url) {
        throw new Error(
          "oauth_client value must contain client_id, client_secret, and token_url",
        );
      }
    } catch (e: any) {
      if (
        e.message.includes("client_id") ||
        e.message.includes("client_secret") ||
        e.message.includes("token_url")
      ) {
        throw e;
      }
      throw new Error(
        "oauth_client value must be valid JSON with client_id, client_secret, and token_url keys",
      );
    }
  } else if (authScheme === "basic") {
    try {
      const parsed = JSON.parse(plaintext);
      if (!parsed.username) {
        throw new Error("basic value must contain a username (password is optional)");
      }
    } catch (e: any) {
      if (e.message.includes("username")) throw e;
      throw new Error("basic value must be valid JSON with username and password keys");
    }
  } else if (authScheme === "header" || authScheme === "query") {
    try {
      const parsed = JSON.parse(plaintext);
      if (!parsed.key || !parsed.secret) {
        throw new Error(`${authScheme} value must contain key and secret`);
      }
    } catch (e: any) {
      if (!(e instanceof SyntaxError)) throw e;
      throw new Error(`${authScheme} value must be valid JSON with key and secret keys`);
    }
  } else if (authScheme === "google_service_account") {
    try {
      const parsed = JSON.parse(plaintext);
      if (!parsed.private_key || !parsed.client_email) {
        throw new Error(
          "google_service_account value must contain private_key and client_email",
        );
      }
    } catch (e: any) {
      if (e.message.includes("private_key") || e.message.includes("client_email")) throw e;
      throw new Error(
        "google_service_account value must be valid Google service account JSON key",
      );
    }
  }

  const encrypted = encryptCredential(plaintext);

  const [row] = await db
    .insert(credentials)
    .values({
      ownerId,
      name,
      authScheme,
      value: encrypted,
      expiresAt: expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [credentials.ownerId, credentials.name],
      set: {
        value: encrypted,
        authScheme,
        expiresAt: expiresAt ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  const isUpdate = row.createdAt.getTime() !== row.updatedAt.getTime();
  await audit(row.id, name, ownerId, isUpdate ? "update" : "create");

  return row;
}

/** Shared credential fetch + permission check. Returns the full row or null. */
async function fetchAndAuthorize(
  name: string,
  ownerId: string,
  requestingUserId: string,
  intent: "read" | "write",
): Promise<typeof credentials.$inferSelect | null> {
  validateKey();
  validateName(name);

  const rows = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.ownerId, ownerId), eq(credentials.name, name)))
    .limit(1);

  const cred = rows[0];
  if (!cred) return null;

  if (cred.expiresAt && cred.expiresAt < new Date()) {
    await audit(cred.id, name, requestingUserId, "expired_access_attempt");
    await notifyOwnerExpired(cred.ownerId, name).catch(() => {});
    return null;
  }

  const allowed = await hasPermission(ownerId, cred.id, requestingUserId, intent);
  if (!allowed) {
    await audit(cred.id, name, requestingUserId, intent, "access_denied");
    throw new Error(`Access denied: ${requestingUserId} cannot ${intent} credential "${name}" owned by ${ownerId}`);
  }

  await audit(cred.id, name, requestingUserId, "read");
  return cred;
}

export async function getApiCredential(
  name: string,
  ownerId: string,
  requestingUserId: string,
  intent: "read" | "write",
): Promise<string | null> {
  const cred = await fetchAndAuthorize(name, ownerId, requestingUserId, intent);
  if (!cred) return null;
  return decryptCredential(cred.value);
}

export async function getApiCredentialWithType(
  name: string,
  ownerId: string,
  requestingUserId: string,
  intent: "read" | "write",
): Promise<{ value: string; authScheme: AuthScheme } | null> {
  const cred = await fetchAndAuthorize(name, ownerId, requestingUserId, intent);
  if (!cred) return null;

  const decrypted = decryptCredential(cred.value);

  if (cred.authScheme === "oauth_client") {
    let parsed: { client_id?: string; client_secret?: string; token_url?: string };
    try {
      parsed = JSON.parse(decrypted);
    } catch {
      throw new Error(`oauth_client credential "${name}" has invalid JSON value`);
    }
    if (!parsed.client_id || !parsed.client_secret) {
      throw new Error(
        `oauth_client credential "${name}" missing client_id or client_secret`,
      );
    }
    if (!parsed.token_url) {
      throw new Error(
        `oauth_client credential "${name}" missing token_url (may need manual repair if migrated from legacy format)`,
      );
    }
    const tokenResponse = await exchangeOAuthToken(
      parsed.token_url,
      parsed.client_id,
      parsed.client_secret,
    );
    return {
      value: tokenResponse.access_token,
      authScheme: cred.authScheme as AuthScheme,
    };
  }

  if (cred.authScheme === "google_service_account") {
    const token = await exchangeGoogleServiceAccountToken(decrypted);
    return {
      value: token,
      authScheme: cred.authScheme as AuthScheme,
    };
  }

  return { value: decrypted, authScheme: cred.authScheme as AuthScheme };
}

async function exchangeGoogleServiceAccountToken(
  jsonKeyStr: string,
): Promise<string> {
  const { GoogleAuth } = await import("google-auth-library");
  let keyData: { client_email: string; private_key: string; scopes?: string };
  try {
    keyData = JSON.parse(jsonKeyStr);
  } catch {
    throw new Error("google_service_account credential has invalid JSON value");
  }

  const auth = new GoogleAuth({
    credentials: {
      client_email: keyData.client_email,
      private_key: keyData.private_key,
    },
    scopes: keyData.scopes
      ? keyData.scopes.split(",").map((s: string) => s.trim())
      : ["https://www.googleapis.com/auth/cloud-platform"],
  });

  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) {
    throw new Error("google_service_account: failed to obtain access token");
  }
  return tokenResponse.token;
}

async function exchangeOAuthToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<{ access_token: string; expires_in?: number }> {
  let resp: Response;
  try {
    resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    });
  } catch (err: any) {
    throw new Error(`Token exchange failed: could not reach ${tokenUrl}: ${err.message}`);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Token exchange failed: ${tokenUrl} returned ${resp.status}${body ? `: ${body}` : ""}`,
    );
  }

  let data: any;
  try {
    data = await resp.json();
  } catch {
    throw new Error(`Token exchange failed: ${tokenUrl} returned non-JSON response`);
  }

  if (!data.access_token || typeof data.access_token !== "string") {
    throw new Error(
      `Token exchange failed: response from ${tokenUrl} missing access_token field`,
    );
  }

  return {
    access_token: data.access_token,
    expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
  };
}

/**
 * Retrieve a credential for a scheduled job. Returns raw decrypted value and auth scheme.
 * NOTE: Does not auto-exchange oauth_client tokens — jobs get raw client_id/client_secret JSON.
 * This is intentional: jobs may need different exchange flows or caching strategies.
 * Use getApiCredentialWithType for interactive tool calls that need auto-exchange.
 */
export async function getJobApiCredential(
  name: string,
  jobId: string,
  creatorId: string,
  declaredCredentialIds: string[],
): Promise<{ value: string; authScheme: AuthScheme } | null> {
  validateKey();
  validateName(name);

  if (declaredCredentialIds.length === 0) return null;

  const rows = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.name, name),
        eq(credentials.ownerId, creatorId),
        sql`${credentials.id} = ANY(${declaredCredentialIds})`,
      ),
    )
    .limit(1);

  const cred = rows[0];
  if (!cred) return null;

  if (cred.expiresAt && cred.expiresAt < new Date()) {
    await audit(cred.id, name, `job:${jobId}`, "expired_access_attempt");
    await notifyOwnerExpired(creatorId, name).catch(() => {});
    return null;
  }

  await audit(cred.id, name, `job:${jobId}`, "use", `creator:${creatorId}`);
  return { value: decryptCredential(cred.value), authScheme: cred.authScheme as AuthScheme };
}

export async function getCredentialById(
  credentialId: string,
): Promise<{ id: string; name: string; ownerId: string } | null> {
  const rows = await db
    .select({
      id: credentials.id,
      name: credentials.name,
      ownerId: credentials.ownerId,
    })
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listApiCredentials(
  userId: string,
): Promise<
  Array<{
    id: string;
    name: string;
    authScheme: AuthScheme;
    owner_id: string;
    expires_at: Date | null;
    permission: "owner" | "read" | "write" | "admin";
  }>
> {
  const owned = await db
    .select({
      id: credentials.id,
      name: credentials.name,
      authScheme: credentials.authScheme,
      owner_id: credentials.ownerId,
      expires_at: credentials.expiresAt,
    })
    .from(credentials)
    .where(eq(credentials.ownerId, userId));

  const granted = await db
    .select({
      id: credentials.id,
      name: credentials.name,
      authScheme: credentials.authScheme,
      owner_id: credentials.ownerId,
      expires_at: credentials.expiresAt,
      permission: credentialGrants.permission,
    })
    .from(credentialGrants)
    .innerJoin(credentials, eq(credentialGrants.credentialId, credentials.id))
    .where(
      and(
        eq(credentialGrants.granteeId, userId),
        isNull(credentialGrants.revokedAt),
      ),
    );

  return [
    ...owned.map((r) => ({ ...r, authScheme: r.authScheme as AuthScheme, permission: "owner" as const })),
    ...granted.map((r) => ({ ...r, authScheme: r.authScheme as AuthScheme, permission: r.permission as "read" | "write" | "admin" })),
  ];
}

export async function listGrantsForCredentials(
  credentialIds: string[],
): Promise<
  Array<{
    credentialId: string;
    granteeId: string;
    permission: string;
    displayName: string | null;
  }>
> {
  if (credentialIds.length === 0) return [];

  const grants = await db
    .select({
      credentialId: credentialGrants.credentialId,
      granteeId: credentialGrants.granteeId,
      permission: credentialGrants.permission,
      displayName: userProfiles.displayName,
    })
    .from(credentialGrants)
    .leftJoin(
      userProfiles,
      eq(credentialGrants.granteeId, userProfiles.slackUserId),
    )
    .where(
      and(
        inArray(credentialGrants.credentialId, credentialIds),
        isNull(credentialGrants.revokedAt),
      ),
    );

  return grants;
}

export async function deleteApiCredential(
  credentialId: string,
  requestingUserId: string,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .limit(1);

  const cred = rows[0];
  if (!cred) return false;

  if (cred.ownerId !== requestingUserId) {
    await audit(cred.id, cred.name, requestingUserId, "delete", "access_denied");
    return false;
  }

  await db.delete(credentials).where(eq(credentials.id, credentialId));
  await audit(null, cred.name, requestingUserId, "delete");
  return true;
}

export async function grantApiCredentialAccess(
  credentialId: string,
  granterId: string,
  granteeId: string,
  permission: "read" | "write" | "admin",
): Promise<void> {
  const rows = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .limit(1);

  const cred = rows[0];
  if (!cred) throw new Error("Credential not found");

  const allowed = await hasPermission(cred.ownerId, credentialId, granterId, "admin");
  if (!allowed) {
    throw new Error("Only the owner or an admin grantee can grant access");
  }

  await db
    .insert(credentialGrants)
    .values({
      credentialId,
      granteeId,
      permission,
      grantedBy: granterId,
    })
    .onConflictDoUpdate({
      target: [credentialGrants.credentialId, credentialGrants.granteeId],
      set: {
        permission,
        grantedBy: granterId,
        grantedAt: new Date(),
        revokedAt: null,
      },
    });

  await audit(credentialId, cred.name, granterId, "grant", `grantee:${granteeId} permission:${permission}`);
}

export async function revokeApiCredentialAccess(
  credentialId: string,
  revokerId: string,
  granteeId: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .limit(1);

  const cred = rows[0];
  if (!cred) throw new Error("Credential not found");

  const allowed = await hasPermission(cred.ownerId, credentialId, revokerId, "admin");
  if (!allowed) {
    throw new Error("Only the owner or an admin grantee can revoke access");
  }

  await db
    .update(credentialGrants)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(credentialGrants.credentialId, credentialId),
        eq(credentialGrants.granteeId, granteeId),
        isNull(credentialGrants.revokedAt),
      ),
    );

  await audit(credentialId, cred.name, revokerId, "revoke", `grantee:${granteeId}`);
}

function scrubValue(error: unknown, plaintext: string): Error {
  const msg =
    error instanceof Error ? error.message : String(error);
  const stack =
    error instanceof Error ? error.stack ?? "" : "";
  const scrubbed = new Error(msg.replaceAll(plaintext, "[REDACTED]"));
  scrubbed.stack = stack.replaceAll(plaintext, "[REDACTED]");
  return scrubbed;
}

export async function withApiCredential<T>(
  name: string,
  ownerId: string,
  requestingUserId: string,
  intent: "read" | "write",
  fn: (value: string) => Promise<T>,
): Promise<T> {
  const plaintext = await getApiCredential(name, ownerId, requestingUserId, intent);
  if (plaintext === null) {
    throw new Error(`Credential "${name}" not found`);
  }

  try {
    const result = await fn(plaintext);

    const rows = await db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(eq(credentials.ownerId, ownerId), eq(credentials.name, name)),
      )
      .limit(1);
    if (rows[0]) {
      await audit(rows[0].id, name, requestingUserId, "use");
    }

    return result;
  } catch (error) {
    throw scrubValue(error, plaintext);
  }
}

export function maskApiCredential(value: string): string {
  if (value.length < 8) {
    const first1 = value.slice(0, 1);
    const last1 = value.slice(-1);
    return `${first1}***${last1}`;
  }
  if (value.length < 12) {
    const first2 = value.slice(0, 2);
    const last2 = value.slice(-2);
    return `${first2}***${last2}`;
  }
  const first4 = value.slice(0, 4);
  const last4 = value.slice(-4);
  return `${first4}***${last4}`;
}

/**
 * One-time data migration: fold `token_url` from the old column into the encrypted
 * value JSON blob for oauth_client credentials.
 *
 * Safe to call at startup — checks whether the legacy `type` column still exists
 * before doing anything. After the SQL migration in 0034 drops that column, this
 * is a no-op. Idempotent: re-running when already migrated does nothing.
 */
export async function runCredentialMigration(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;

  // Check if the old `type` column still exists (pre-migration state)
  const { neon } = await import("@neondatabase/serverless");
  const rawSql = neon(connectionString);

  const cols = await rawSql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'credentials'
      AND column_name = 'type'
  `;

  if (cols.length === 0) {
    // Column already gone — migration already ran, nothing to do
    return;
  }

  logger.info("runCredentialMigration: folding token_url into oauth_client value blobs");

  // Fetch all oauth_client rows via raw SQL (Drizzle schema no longer has these columns)
  const rows = await rawSql`
    SELECT id, value, token_url
    FROM credentials
    WHERE type = 'oauth_client'
  `;

  for (const row of rows) {
    try {
      const decrypted = decryptCredential(row.value as string);
      let parsed: Record<string, string> = {};
      try {
        parsed = JSON.parse(decrypted);
      } catch {
        // value wasn't JSON yet — treat as empty object
      }

      // Migrate token_url if present; if null/undefined, leave it out of the JSON blob
      // (credential will need manual repair later, but won't crash on read)
      if (row.token_url && !parsed.token_url) {
        parsed.token_url = row.token_url as string;
      } else if (!row.token_url && !parsed.token_url) {
        // No token_url available — log warning but continue migration
        logger.warn("runCredentialMigration: oauth_client credential missing token_url", {
          id: row.id,
        });
        // Don't set token_url in the blob; the credential will fail validation on read,
        // but at least the migration won't crash
      }

      const { encryptCredential: enc } = await import("./credentials.js");
      const reEncrypted = enc(JSON.stringify(parsed));

      await rawSql`
        UPDATE credentials
        SET value = ${reEncrypted},
            auth_scheme = 'oauth_client',
            updated_at = NOW()
        WHERE id = ${row.id}
      `;
    } catch (err) {
      logger.error("runCredentialMigration: failed to migrate row", { id: row.id, err });
    }
  }

  // Ensure all legacy token rows are marked as bearer
  await rawSql`
    UPDATE credentials
    SET auth_scheme = 'bearer'
    WHERE type = 'token'
      AND auth_scheme != 'bearer'
  `;

  logger.info("runCredentialMigration: complete");
}
