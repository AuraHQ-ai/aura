import { Hono } from "hono";
import { eq, ilike, sql, desc } from "drizzle-orm";
import {
  credentials,
  credentialGrants,
  credentialAuditLog,
  userProfiles,
} from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import {
  encryptCredential,
  decryptCredential,
  maskCredential,
} from "../../lib/credentials.js";

export const dashboardCredentialsApp = new Hono();

dashboardCredentialsApp.get("/", async (c) => {
  try {
    const search = c.req.query("search");
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20));
    const offset = (page - 1) * limit;

    const where = search
      ? ilike(credentials.name, `%${search}%`)
      : undefined;

    const [items, [{ total }]] = await Promise.all([
      db
        .select({
          id: credentials.id,
          name: credentials.name,
          type: credentials.type,
          ownerId: credentials.ownerId,
          expiresAt: credentials.expiresAt,
          createdAt: credentials.createdAt,
          grantCount: sql<number>`(
            SELECT count(*)::int FROM credential_grants
            WHERE credential_grants.credential_id = ${credentials.id}
              AND credential_grants.revoked_at IS NULL
          )`,
          ownerName: sql<string | null>`(
            SELECT display_name FROM user_profiles
            WHERE user_profiles.slack_user_id = ${credentials.ownerId}
            LIMIT 1
          )`,
        })
        .from(credentials)
        .where(where)
        .orderBy(desc(credentials.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(credentials)
        .where(where),
    ]);

    return c.json({ items, total });
  } catch (error) {
    logger.error("Failed to list credentials", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

dashboardCredentialsApp.post("/", async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      type: string;
      ownerId: string;
      value: string;
      expiresAt?: string;
      tokenUrl?: string;
    }>();

    const encrypted = encryptCredential(body.value);

    const [created] = await db
      .insert(credentials)
      .values({
        name: body.name,
        type: body.type,
        ownerId: body.ownerId,
        value: encrypted,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        tokenUrl: body.tokenUrl,
      })
      .returning({
        id: credentials.id,
        name: credentials.name,
        type: credentials.type,
        ownerId: credentials.ownerId,
        expiresAt: credentials.expiresAt,
        createdAt: credentials.createdAt,
      });

    return c.json(created, 201);
  } catch (error) {
    logger.error("Failed to create credential", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

dashboardCredentialsApp.get("/:id", async (c) => {
  try {
    const id = c.req.param("id");

    const [cred] = await db
      .select()
      .from(credentials)
      .where(eq(credentials.id, id))
      .limit(1);

    if (!cred) return c.json({ error: "Not found" }, 404);

    const maskedValue = maskCredential(decryptCredential(cred.value));

    const [grants, auditLog, ownerRow] = await Promise.all([
      db
        .select({
          id: credentialGrants.id,
          granteeId: credentialGrants.granteeId,
          permission: credentialGrants.permission,
          grantedBy: credentialGrants.grantedBy,
          grantedAt: credentialGrants.grantedAt,
          revokedAt: credentialGrants.revokedAt,
          granteeName: sql<string | null>`(
            SELECT display_name FROM user_profiles
            WHERE user_profiles.slack_user_id = ${credentialGrants.granteeId}
            LIMIT 1
          )`,
        })
        .from(credentialGrants)
        .where(eq(credentialGrants.credentialId, id)),
      db
        .select()
        .from(credentialAuditLog)
        .where(eq(credentialAuditLog.credentialId, id))
        .orderBy(desc(credentialAuditLog.timestamp))
        .limit(50),
      db
        .select({ displayName: userProfiles.displayName })
        .from(userProfiles)
        .where(eq(userProfiles.slackUserId, cred.ownerId))
        .limit(1),
    ]);

    return c.json({
      id: cred.id,
      name: cred.name,
      type: cred.type,
      ownerId: cred.ownerId,
      ownerName: ownerRow[0]?.displayName ?? null,
      maskedValue,
      tokenUrl: cred.tokenUrl,
      expiresAt: cred.expiresAt,
      createdAt: cred.createdAt,
      updatedAt: cred.updatedAt,
      grants,
      auditLog,
    });
  } catch (error) {
    logger.error("Failed to get credential", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

dashboardCredentialsApp.patch("/:id/value", async (c) => {
  try {
    const id = c.req.param("id");
    const { value } = await c.req.json<{ value: string }>();

    const encrypted = encryptCredential(value);

    const [updated] = await db
      .update(credentials)
      .set({ value: encrypted, updatedAt: new Date() })
      .where(eq(credentials.id, id))
      .returning({ id: credentials.id });

    if (!updated) return c.json({ error: "Not found" }, 404);

    return c.json({ ok: true });
  } catch (error) {
    logger.error("Failed to update credential value", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

dashboardCredentialsApp.post("/:id/grants", async (c) => {
  try {
    const credentialId = c.req.param("id");
    const body = await c.req.json<{
      granteeId: string;
      permission: string;
      grantedBy: string;
    }>();

    const [grant] = await db
      .insert(credentialGrants)
      .values({
        credentialId,
        granteeId: body.granteeId,
        permission: body.permission,
        grantedBy: body.grantedBy,
      })
      .onConflictDoUpdate({
        target: [credentialGrants.credentialId, credentialGrants.granteeId],
        set: {
          permission: body.permission,
          grantedBy: body.grantedBy,
          grantedAt: new Date(),
          revokedAt: null,
        },
      })
      .returning();

    return c.json(grant, 201);
  } catch (error) {
    logger.error("Failed to grant credential access", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

dashboardCredentialsApp.delete("/:id/grants/:grantId", async (c) => {
  try {
    const grantId = c.req.param("grantId");

    const [revoked] = await db
      .update(credentialGrants)
      .set({ revokedAt: new Date() })
      .where(eq(credentialGrants.id, grantId))
      .returning({ id: credentialGrants.id });

    if (!revoked) return c.json({ error: "Not found" }, 404);

    return c.json({ ok: true });
  } catch (error) {
    logger.error("Failed to revoke credential grant", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

dashboardCredentialsApp.delete("/:id", async (c) => {
  try {
    const id = c.req.param("id");

    const [deleted] = await db
      .delete(credentials)
      .where(eq(credentials.id, id))
      .returning({ id: credentials.id });

    if (!deleted) return c.json({ error: "Not found" }, 404);

    return c.json({ ok: true });
  } catch (error) {
    logger.error("Failed to delete credential", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});
