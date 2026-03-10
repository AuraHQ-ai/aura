"use server";

import { db } from "@/lib/db";
import { credentials, credentialGrants, credentialAuditLog, userProfiles } from "@schema";
import { eq, desc, count } from "drizzle-orm";
import { encryptCredential, decryptCredential, maskCredential } from "@/lib/credentials";
import { revalidatePath } from "next/cache";

export async function getCredentials() {
  const creds = await db
    .select({
      id: credentials.id,
      name: credentials.name,
      type: credentials.type,
      ownerId: credentials.ownerId,
      sandboxEnvName: credentials.sandboxEnvName,
      expiresAt: credentials.expiresAt,
      createdAt: credentials.createdAt,
    })
    .from(credentials)
    .orderBy(desc(credentials.createdAt));

  const result = [];
  for (const cred of creds) {
    const [grantCount] = await db
      .select({ value: count() })
      .from(credentialGrants)
      .where(eq(credentialGrants.credentialId, cred.id));

    const [owner] = await db
      .select({ displayName: userProfiles.displayName })
      .from(userProfiles)
      .where(eq(userProfiles.slackUserId, cred.ownerId));

    result.push({
      ...cred,
      grantCount: grantCount.value,
      ownerName: owner?.displayName || cred.ownerId,
    });
  }

  return result;
}

export async function getCredential(id: string) {
  const [cred] = await db.select().from(credentials).where(eq(credentials.id, id));
  if (!cred) return null;

  let maskedValue = "";
  try {
    maskedValue = maskCredential(decryptCredential(cred.value));
  } catch {
    maskedValue = "••••••••";
  }

  const grants = await db
    .select()
    .from(credentialGrants)
    .where(eq(credentialGrants.credentialId, id));

  const granteeNames: Record<string, string> = {};
  for (const g of grants) {
    const [profile] = await db
      .select({ displayName: userProfiles.displayName })
      .from(userProfiles)
      .where(eq(userProfiles.slackUserId, g.granteeId));
    granteeNames[g.granteeId] = profile?.displayName || g.granteeId;
  }

  const auditLog = await db
    .select()
    .from(credentialAuditLog)
    .where(eq(credentialAuditLog.credentialId, id))
    .orderBy(desc(credentialAuditLog.timestamp))
    .limit(50);

  const [owner] = await db
    .select({ displayName: userProfiles.displayName })
    .from(userProfiles)
    .where(eq(userProfiles.slackUserId, cred.ownerId));

  return {
    ...cred,
    maskedValue,
    ownerName: owner?.displayName || cred.ownerId,
    grants,
    granteeNames,
    auditLog,
  };
}

export async function createCredential(data: {
  name: string;
  type: string;
  ownerId: string;
  value: string;
  sandboxEnvName?: string;
  expiresAt?: string;
  tokenUrl?: string;
}) {
  const encrypted = encryptCredential(data.value);
  const [cred] = await db
    .insert(credentials)
    .values({
      name: data.name,
      type: data.type,
      ownerId: data.ownerId,
      value: encrypted,
      sandboxEnvName: data.sandboxEnvName || null,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      tokenUrl: data.tokenUrl || null,
    })
    .returning();
  revalidatePath("/credentials");
  return cred;
}

export async function updateSandboxEnvName(id: string, sandboxEnvName: string | null) {
  await db
    .update(credentials)
    .set({ sandboxEnvName, updatedAt: new Date() })
    .where(eq(credentials.id, id));
  revalidatePath(`/credentials/${id}`);
  revalidatePath("/credentials");
}

export async function updateCredentialValue(id: string, value: string) {
  const encrypted = encryptCredential(value);
  await db
    .update(credentials)
    .set({ value: encrypted, updatedAt: new Date() })
    .where(eq(credentials.id, id));
  revalidatePath(`/credentials/${id}`);
}

export async function grantCredentialAccess(credentialId: string, granteeId: string, permission: string, grantedBy: string) {
  await db
    .insert(credentialGrants)
    .values({ credentialId, granteeId, permission, grantedBy })
    .onConflictDoUpdate({
      target: [credentialGrants.credentialId, credentialGrants.granteeId],
      set: { permission, grantedBy, grantedAt: new Date(), revokedAt: null },
    });
  revalidatePath(`/credentials/${credentialId}`);
}

export async function revokeCredentialAccess(grantId: string, credentialId: string) {
  await db
    .update(credentialGrants)
    .set({ revokedAt: new Date() })
    .where(eq(credentialGrants.id, grantId));
  revalidatePath(`/credentials/${credentialId}`);
}

export async function deleteCredential(id: string) {
  await db.delete(credentials).where(eq(credentials.id, id));
  revalidatePath("/credentials");
}
