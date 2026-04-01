import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  users,
  addresses,
  type User,
} from "@aura/db/schema";
import { logger } from "./logger.js";
import { ensureSlackUserEntityLink } from "../users/entity-link.js";

/**
 * Find a user by any address (email, phone, slack ID).
 */
export async function resolvePersonByAddress(
  channel: string,
  value: string,
): Promise<User | null> {
  const normalised = normaliseValue(channel, value);
  const rows = await db
    .select({ user: users })
    .from(addresses)
    .innerJoin(users, eq(addresses.userId, users.id))
    .where(and(eq(addresses.channel, channel), eq(addresses.value, normalised)))
    .limit(1);

  return rows.length > 0 ? rows[0].user : null;
}

/**
 * Create a user with an initial address.
 * If the address already exists (conflict), returns the existing user.
 */
export async function createPersonWithAddress(
  displayName: string | null,
  channel: string,
  value: string,
): Promise<User> {
  const normalised = normaliseValue(channel, value);

  const userValues: Record<string, unknown> = {
    displayName: displayName || normalised,
  };
  if (channel === "slack") {
    userValues.slackUserId = normalised;
  }

  const [user] = await db
    .insert(users)
    .values(userValues as typeof users.$inferInsert)
    .returning();

  try {
    const insertedAddress = await db
      .insert(addresses)
      .values({
        userId: user.id,
        channel,
        value: normalised,
        isPrimary: true,
      })
      .onConflictDoNothing()
      .returning();

    if (insertedAddress.length === 0) {
      await db.delete(users).where(eq(users.id, user.id));
      const existing = await resolvePersonByAddress(channel, value);
      if (existing) return existing;

      // Address exists but has no linked user (orphaned from migration).
      // Adopt it by linking it to a fresh user.
      const orphaned = await db
        .select({ id: addresses.id })
        .from(addresses)
        .where(
          and(
            eq(addresses.channel, channel),
            eq(addresses.value, normalised),
            isNull(addresses.userId),
          ),
        )
        .limit(1);

      if (orphaned.length > 0) {
        const [adoptedUser] = await db
          .insert(users)
          .values(userValues as typeof users.$inferInsert)
          .returning();
        try {
          await db
            .update(addresses)
            .set({ userId: adoptedUser.id })
            .where(eq(addresses.id, orphaned[0].id));
        } catch (linkError) {
          await db.delete(users).where(eq(users.id, adoptedUser.id)).catch(() => {});
          throw linkError;
        }
        return adoptedUser;
      }

      throw new Error(
        `Address conflict but could not resolve user for ${channel}:${value}`,
      );
    }
  } catch (error) {
    await db.delete(users).where(eq(users.id, user.id)).catch(() => {});
    throw error;
  }

  if (channel === "slack") {
    try {
      await ensureSlackUserEntityLink({
        userId: user.id,
        slackUserId: normalised,
        displayName: user.displayName,
        workspaceId: user.workspaceId ?? "default",
      });
    } catch (error) {
      logger.warn("Failed to ensure entity link for new slack user", {
        slackUserId: normalised,
        error: String(error),
      });
    }
  }

  return user;
}

/**
 * Resolve or create a user for a given email address.
 * Checks if the email already maps to a user via addresses table,
 * otherwise creates a new user with the email address.
 */
export async function resolveOrCreateFromEmail(
  email: string,
  displayName: string | null,
): Promise<string> {
  const normEmail = email.toLowerCase();

  const existing = await resolvePersonByAddress("email", normEmail);
  if (existing) return existing.id;

  const user = await createPersonWithAddress(displayName, "email", normEmail);
  return user.id;
}

function normaliseValue(channel: string, value: string): string {
  if (channel === "email" || channel === "phone") {
    return value.toLowerCase();
  }
  return value;
}
