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
  type: "token" | "oauth_client" = "token",
  tokenUrl?: string,
): Promise<Credential> {
  validateKey();
  validateName(name);

  if (type === "oauth_client") {
    try {
      const parsed = JSON.parse(plaintext);
      if (!parsed.client_id || !parsed.client_secret) {
        throw new Error("oauth_client value must contain client_id and client_secret");
      }
    } catch (e: any) {
      if (e.message.includes("client_id") || e.message.includes("client_secret")) throw e;
      throw new Error("oauth_client value must be valid JSON with client_id and client_secret keys");
    }
  }

  const encrypted = encryptCredential(plaintext);

  const [row] = await db
    .insert(credentials)
    .values({
      ownerId,
      name,
      type,
      tokenUrl: type === "oauth_client" ? (tokenUrl ?? null) : null,
      value: encrypted,
      expiresAt: expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [credentials.ownerId, credentials.name],
      set: {
        value: encrypted,
        type,
        tokenUrl: type === "oauth_client" ? (tokenUrl ?? null) : null,
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
): Promise<{ value: string; type: string; access_token?: string; expires_in?: number } | null> {
  const cred = await fetchAndAuthorize(name, ownerId, requestingUserId, intent);
  if (!cred) return null;

  const decrypted = decryptCredential(cred.value);

  if (cred.type === "oauth_client" && cred.tokenUrl) {
    let parsed: { client_id: string; client_secret: string };
    try {
      parsed = JSON.parse(decrypted);
    } catch {
      throw new Error(`oauth_client credential "${name}" has invalid JSON value`);
    }
    if (!parsed.client_id || !parsed.client_secret) {
      throw new Error(`oauth_client credential "${name}" missing client_id or client_secret`);
    }
    const tokenResponse = await exchangeOAuthToken(
      cred.tokenUrl,
      parsed.client_id,
      parsed.client_secret,
    );
    return {
      value: tokenResponse.access_token,
      type: cred.type,
      access_token: tokenResponse.access_token,
      expires_in: tokenResponse.expires_in,
    };
  }

  return { value: decrypted, type: cred.type };
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
 * Retrieve a credential for a scheduled job. Returns raw decrypted value.
 * NOTE: Does not auto-exchange oauth_client tokens — jobs get raw client_id/client_secret JSON.
 * This is intentional: jobs may need different exchange flows or caching strategies.
 * Use getApiCredentialWithType for interactive tool calls that need auto-exchange.
 */
export async function getJobApiCredential(
  name: string,
  jobId: string,
  creatorId: string,
  declaredCredentialIds: string[],
): Promise<string | null> {
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
  return decryptCredential(cred.value);
}

export async function listApiCredentials(
  userId: string,
): Promise<
  Array<{
    id: string;
    name: string;
    type: string;
    owner_id: string;
    expires_at: Date | null;
    permission: "owner" | "read" | "write" | "admin";
  }>
> {
  const owned = await db
    .select({
      id: credentials.id,
      name: credentials.name,
      type: credentials.type,
      owner_id: credentials.ownerId,
      expires_at: credentials.expiresAt,
    })
    .from(credentials)
    .where(eq(credentials.ownerId, userId));

  const granted = await db
    .select({
      id: credentials.id,
      name: credentials.name,
      type: credentials.type,
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
    ...owned.map((r) => ({ ...r, permission: "owner" as const })),
    ...granted.map((r) => ({ ...r, permission: r.permission as "read" | "write" | "admin" })),
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
