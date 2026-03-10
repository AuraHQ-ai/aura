import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  people,
  addresses,
  userProfiles,
  type Person,
} from "@aura/db/schema";
import { logger } from "./logger.js";

/**
 * Find a person by any address (email, phone, slack ID).
 */
export async function resolvePersonByAddress(
  channel: string,
  value: string,
): Promise<Person | null> {
  const normalised = normaliseValue(channel, value);
  const rows = await db
    .select({ person: people })
    .from(addresses)
    .innerJoin(people, eq(addresses.personId, people.id))
    .where(and(eq(addresses.channel, channel), eq(addresses.value, normalised)))
    .limit(1);

  return rows.length > 0 ? rows[0].person : null;
}

/**
 * Create a person with an initial address.
 * If the address already exists (conflict), returns the existing person.
 */
export async function createPersonWithAddress(
  displayName: string | null,
  channel: string,
  value: string,
): Promise<Person> {
  const normalised = normaliseValue(channel, value);

  const personValues: Record<string, unknown> = { displayName };
  if (channel === "slack") {
    personValues.slackUserId = normalised;
  }

  const [person] = await db
    .insert(people)
    .values(personValues as typeof people.$inferInsert)
    .returning();

  try {
    const insertedAddress = await db
      .insert(addresses)
      .values({
        personId: person.id,
        channel,
        value: normalised,
        isPrimary: true,
      })
      .onConflictDoNothing()
      .returning();

    if (insertedAddress.length === 0) {
      await db.delete(people).where(eq(people.id, person.id));
      const existing = await resolvePersonByAddress(channel, value);
      if (!existing) {
        throw new Error(
          `Address conflict but could not resolve person for ${channel}:${value}`,
        );
      }
      return existing;
    }
  } catch (error) {
    await db.delete(people).where(eq(people.id, person.id)).catch(() => {});
    throw error;
  }

  return person;
}

/**
 * Link a user_profile to a person (set person_id FK).
 */
export async function linkProfileToPerson(
  profileId: string,
  personId: string,
): Promise<void> {
  await db
    .update(userProfiles)
    .set({ personId, updatedAt: new Date() })
    .where(eq(userProfiles.id, profileId));
}

/**
 * Ensure a profile is linked to a person (called from getOrCreateProfile).
 * Creates a person + slack address if one doesn't exist yet.
 */
export async function ensurePersonLinked(profile: {
  id: string;
  slackUserId: string;
  displayName: string | null;
  personId?: string | null;
}): Promise<string> {
  if (profile.personId) return profile.personId;

  const existing = await resolvePersonByAddress("slack", profile.slackUserId);
  if (existing) {
    await linkProfileToPerson(profile.id, existing.id);
    return existing.id;
  }

  const person = await createPersonWithAddress(
    profile.displayName,
    "slack",
    profile.slackUserId,
  );
  await linkProfileToPerson(profile.id, person.id);
  return person.id;
}

/**
 * Backfill: create people from all user_profiles that don't have a person yet.
 * For each user_profile with a slack_user_id:
 *   1. Create a person row (display_name from profile, slack_user_id)
 *   2. Create an address row (channel='slack', value=slack_user_id, is_primary=true)
 *   3. Set user_profiles.person_id = new person.id
 */
export async function backfillPeopleFromProfiles(): Promise<{
  created: number;
  skipped: number;
}> {
  const unlinked = await db
    .select()
    .from(userProfiles)
    .where(isNull(userProfiles.personId));

  let created = 0;
  let skipped = 0;

  for (const profile of unlinked) {
    try {
      await ensurePersonLinked(profile);
      created++;
    } catch (error) {
      logger.error("Failed to backfill profile", {
        profileId: profile.id,
        slackUserId: profile.slackUserId,
        error: String(error),
      });
      skipped++;
    }
  }

  logger.info("Backfill complete", {
    created,
    skipped,
    total: unlinked.length,
  });
  return { created, skipped };
}

/**
 * Resolve or create a person for a given email address.
 * Checks if the email already maps to a person via addresses table,
 * otherwise creates a new person with the email address.
 */
export async function resolveOrCreateFromEmail(
  email: string,
  displayName: string | null,
): Promise<string> {
  const normEmail = email.toLowerCase();

  const existing = await resolvePersonByAddress("email", normEmail);
  if (existing) return existing.id;

  const person = await createPersonWithAddress(displayName, "email", normEmail);
  return person.id;
}

function normaliseValue(channel: string, value: string): string {
  if (channel === "email" || channel === "phone") {
    return value.toLowerCase();
  }
  return value;
}
