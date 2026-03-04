import { eq, and, or, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  credentials,
  credentialGrants,
  credentialAuditLog,
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

const PERMISSION_LEVELS: Record<string, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

function hasPermission(
  granted: string,
  required: "read" | "write",
): boolean {
  return (PERMISSION_LEVELS[granted] ?? 0) >= (PERMISSION_LEVELS[required] ?? 0);
}

export async function storeApiCredential(
  ownerId: string,
  name: string,
  plaintext: string,
  expiresAt?: Date,
): Promise<Credential> {
  validateKey();
  validateName(name);

  const encrypted = encryptCredential(plaintext);

  const [row] = await db
    .insert(credentials)
    .values({
      ownerId,
      name,
      value: encrypted,
      expiresAt: expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [credentials.ownerId, credentials.name],
      set: {
        value: encrypted,
        expiresAt: expiresAt ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  const isUpdate = row.createdAt.getTime() !== row.updatedAt.getTime();
  await audit(row.id, name, ownerId, isUpdate ? "update" : "create");

  return row;
}

export async function getApiCredential(
  name: string,
  ownerId: string,
  requestingUserId: string,
  intent: "read" | "write",
): Promise<string | null> {
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

  if (ownerId !== requestingUserId) {
    const grants = await db
      .select()
      .from(credentialGrants)
      .where(
        and(
          eq(credentialGrants.credentialId, cred.id),
          eq(credentialGrants.granteeId, requestingUserId),
          isNull(credentialGrants.revokedAt),
        ),
      )
      .limit(1);

    const grant = grants[0];
    if (!grant || !hasPermission(grant.permission, intent)) {
      await audit(cred.id, name, requestingUserId, "read", "access_denied");
      return null;
    }
  }

  await audit(cred.id, name, requestingUserId, "read");
  return decryptCredential(cred.value);
}

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
    owner_id: string;
    expires_at: Date | null;
    permission: string;
  }>
> {
  const owned = await db
    .select({
      id: credentials.id,
      name: credentials.name,
      owner_id: credentials.ownerId,
      expires_at: credentials.expiresAt,
    })
    .from(credentials)
    .where(eq(credentials.ownerId, userId));

  const granted = await db
    .select({
      id: credentials.id,
      name: credentials.name,
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
    ...owned.map((r) => ({ ...r, permission: "owner" })),
    ...granted,
  ];
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

  if (cred.ownerId !== granterId) {
    const granterGrants = await db
      .select()
      .from(credentialGrants)
      .where(
        and(
          eq(credentialGrants.credentialId, credentialId),
          eq(credentialGrants.granteeId, granterId),
          isNull(credentialGrants.revokedAt),
          eq(credentialGrants.permission, "admin"),
        ),
      )
      .limit(1);

    if (granterGrants.length === 0) {
      throw new Error("Only the owner or an admin grantee can grant access");
    }
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

  if (cred.ownerId !== revokerId) {
    const revokerGrants = await db
      .select()
      .from(credentialGrants)
      .where(
        and(
          eq(credentialGrants.credentialId, credentialId),
          eq(credentialGrants.granteeId, revokerId),
          isNull(credentialGrants.revokedAt),
          eq(credentialGrants.permission, "admin"),
        ),
      )
      .limit(1);

    if (revokerGrants.length === 0) {
      throw new Error("Only the owner or an admin grantee can revoke access");
    }
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
    throw new Error(`Credential "${name}" not found or access denied`);
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
