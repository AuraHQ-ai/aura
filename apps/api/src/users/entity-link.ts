import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { entities, entityAliases, users } from "@aura/db/schema";
import { resolveEntity } from "../memory/entity-resolution.js";
import { logger } from "../lib/logger.js";

interface EnsureSlackUserEntityLinkInput {
  userId?: string;
  slackUserId: string;
  displayName?: string | null;
  workspaceId?: string;
}

/**
 * Enforce the invariant: every Slack user must be linked to a person entity.
 * Also keeps entities.slack_user_id aligned with users.slack_user_id.
 */
export async function ensureSlackUserEntityLink(
  input: EnsureSlackUserEntityLinkInput,
): Promise<string | null> {
  if (!input.slackUserId) return null;

  const [user] = await db
    .select({
      id: users.id,
      workspaceId: users.workspaceId,
      slackUserId: users.slackUserId,
      displayName: users.displayName,
      entityId: users.entityId,
    })
    .from(users)
    .where(
      input.userId
        ? eq(users.id, input.userId)
        : eq(users.slackUserId, input.slackUserId),
    )
    .limit(1);

  if (!user?.slackUserId) return null;

  const workspaceId = input.workspaceId ?? user.workspaceId ?? "default";
  const displayName =
    (input.displayName ?? user.displayName ?? user.slackUserId).trim();

  // 1) Prefer entity already linked by Slack user ID.
  const [entityBySlack] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.type, "person"),
        eq(entities.slackUserId, user.slackUserId),
      ),
    )
    .limit(1);

  if (entityBySlack) {
    if (user.entityId !== entityBySlack.id) {
      await db
        .update(users)
        .set({ entityId: entityBySlack.id, updatedAt: new Date() })
        .where(eq(users.id, user.id));
    }
    return entityBySlack.id;
  }

  // 2) If users.entity_id exists and is compatible, keep it.
  let targetEntityId = user.entityId;
  if (targetEntityId) {
    const [linkedEntity] = await db
      .select({ id: entities.id, slackUserId: entities.slackUserId })
      .from(entities)
      .where(eq(entities.id, targetEntityId))
      .limit(1);

    if (
      !linkedEntity ||
      (linkedEntity.slackUserId &&
        linkedEntity.slackUserId !== user.slackUserId)
    ) {
      targetEntityId = null;
    }
  }

  // 3) Otherwise resolve by person name. If collision on another slack ID, create dedicated entity.
  if (!targetEntityId) {
    const resolved = await resolveEntity(displayName, "person", workspaceId);
    const [resolvedEntity] = await db
      .select({ id: entities.id, slackUserId: entities.slackUserId })
      .from(entities)
      .where(eq(entities.id, resolved.entityId))
      .limit(1);

    if (
      resolvedEntity?.slackUserId &&
      resolvedEntity.slackUserId !== user.slackUserId
    ) {
      const [created] = await db
        .insert(entities)
        .values({
          workspaceId,
          type: "person",
          canonicalName: displayName,
          slackUserId: user.slackUserId,
        })
        .onConflictDoNothing()
        .returning({ id: entities.id });

      if (created) {
        targetEntityId = created.id;
        await db
          .insert(entityAliases)
          .values({
            entityId: created.id,
            alias: displayName,
            source: "auto_generated",
          })
          .onConflictDoNothing();
      } else {
        const [createdByRace] = await db
          .select({ id: entities.id })
          .from(entities)
          .where(
            and(
              eq(entities.workspaceId, workspaceId),
              eq(entities.type, "person"),
              eq(entities.slackUserId, user.slackUserId),
            ),
          )
          .limit(1);
        targetEntityId = createdByRace?.id ?? null;
      }
    } else {
      targetEntityId = resolved.entityId;
    }
  }

  if (!targetEntityId) {
    logger.warn("Failed to ensure Slack user entity link", {
      userId: user.id,
      slackUserId: user.slackUserId,
      workspaceId,
    });
    return null;
  }

  await db
    .update(users)
    .set({ entityId: targetEntityId, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  await db
    .update(entities)
    .set({ slackUserId: user.slackUserId, updatedAt: new Date() })
    .where(and(eq(entities.id, targetEntityId), isNull(entities.slackUserId)));

  return targetEntityId;
}
