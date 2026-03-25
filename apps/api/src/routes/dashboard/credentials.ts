import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
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
import { errorSchema, paginationQuerySchema, idParamSchema, okSchema } from "./schemas.js";

export const dashboardCredentialsApp = new OpenAPIHono();

const listCredentialsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Credentials"],
  summary: "List credentials",
  request: {
    query: paginationQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(z.any()),
            total: z.number(),
          }),
        },
      },
      description: "Success",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardCredentialsApp.openapi(listCredentialsRoute, async (c) => {
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

    return c.json({ items, total } as any, 200);
  } catch (error) {
    logger.error("Failed to list credentials", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const createCredentialRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Credentials"],
  summary: "Create a credential",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string(),
            type: z.string(),
            ownerId: z.string(),
            value: z.string(),
            expiresAt: z.string().optional(),
            tokenUrl: z.string().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.any() } },
      description: "Created",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardCredentialsApp.openapi(createCredentialRoute, async (c) => {
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

    return c.json(created as any, 201);
  } catch (error) {
    logger.error("Failed to create credential", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const getCredentialRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Credentials"],
  summary: "Get credential detail",
  request: {
    params: idParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardCredentialsApp.openapi(getCredentialRoute, async (c) => {
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

    return c.json(
      {
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
      } as any,
      200,
    );
  } catch (error) {
    logger.error("Failed to get credential", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const updateCredentialValueRoute = createRoute({
  method: "patch",
  path: "/{id}/value",
  tags: ["Credentials"],
  summary: "Update credential value",
  request: {
    params: idParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({ value: z.string() }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: okSchema } },
      description: "Success",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardCredentialsApp.openapi(updateCredentialValueRoute, async (c) => {
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

    return c.json({ ok: true } as any, 200);
  } catch (error) {
    logger.error("Failed to update credential value", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const createGrantRoute = createRoute({
  method: "post",
  path: "/{id}/grants",
  tags: ["Credentials"],
  summary: "Grant credential access",
  request: {
    params: idParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            granteeId: z.string(),
            permission: z.string(),
            grantedBy: z.string(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.any() } },
      description: "Created",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardCredentialsApp.openapi(createGrantRoute, async (c) => {
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
        target: [credentialGrants.workspaceId, credentialGrants.credentialId, credentialGrants.granteeId],
        set: {
          permission: body.permission,
          grantedBy: body.grantedBy,
          grantedAt: new Date(),
          revokedAt: null,
        },
      })
      .returning();

    return c.json(grant as any, 201);
  } catch (error) {
    logger.error("Failed to grant credential access", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const revokeGrantRoute = createRoute({
  method: "delete",
  path: "/{id}/grants/{grantId}",
  tags: ["Credentials"],
  summary: "Revoke credential grant",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" } }),
      grantId: z.string().openapi({ param: { name: "grantId", in: "path" } }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: okSchema } },
      description: "Success",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardCredentialsApp.openapi(revokeGrantRoute, async (c) => {
  try {
    const grantId = c.req.param("grantId");

    const [revoked] = await db
      .update(credentialGrants)
      .set({ revokedAt: new Date() })
      .where(eq(credentialGrants.id, grantId))
      .returning({ id: credentialGrants.id });

    if (!revoked) return c.json({ error: "Not found" }, 404);

    return c.json({ ok: true } as any, 200);
  } catch (error) {
    logger.error("Failed to revoke credential grant", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const deleteCredentialRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Credentials"],
  summary: "Delete a credential",
  request: {
    params: idParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: okSchema } },
      description: "Success",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardCredentialsApp.openapi(deleteCredentialRoute, async (c) => {
  try {
    const id = c.req.param("id");

    const [deleted] = await db
      .delete(credentials)
      .where(eq(credentials.id, id))
      .returning({ id: credentials.id });

    if (!deleted) return c.json({ error: "Not found" }, 404);

    return c.json({ ok: true } as any, 200);
  } catch (error) {
    logger.error("Failed to delete credential", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});
