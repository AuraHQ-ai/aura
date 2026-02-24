import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  people,
  addresses,
  userProfiles,
  type Person,
  type Address,
} from "../db/schema.js";
import { logger } from "./logger.js";

/**
 * Resolve a person by channel + value.
 * Returns the person ID if found, null otherwise.
 */
export async function resolvePersonByAddress(
  channel: string,
  value: string,
): Promise<string | null> {
  const normalised = normaliseValue(channel, value);
  const rows = await db
    .select({ personId: addresses.personId })
    .from(addresses)
    .where(and(eq(addresses.channel, channel), eq(addresses.value, normalised)))
    .limit(1);

  return rows.length > 0 ? rows[0].personId : null;
}

/**
 * Create a person with an initial address.
 * If the address already exists (conflict), cleans up the orphaned person
 * and returns the existing person that owns the address.
 */
export async function createPersonWithAddress(
  displayName: string | null,
  channel: string,
  value: string,
  source: string,
  confidence = 1.0,
): Promise<Person> {
  const [person] = await db
    .insert(people)
    .values({ displayName })
    .returning();

  const normalised = normaliseValue(channel, value);
  let insertedAddress: Address[];
  try {
    insertedAddress = await db
      .insert(addresses)
      .values({
        personId: person.id,
        channel,
        value: normalised,
        source,
        confidence,
      })
      .onConflictDoNothing()
      .returning();
  } catch (error) {
    await db.delete(people).where(eq(people.id, person.id)).catch(() => {});
    throw error;
  }

  if (insertedAddress.length === 0) {
    await db.delete(people).where(eq(people.id, person.id));
    const existingPersonId = await resolvePersonByAddress(channel, value);
    if (!existingPersonId) {
      throw new Error(
        `Address conflict but could not resolve person for ${channel}:${value}`,
      );
    }
    const [existingPerson] = await db
      .select()
      .from(people)
      .where(eq(people.id, existingPersonId))
      .limit(1);
    return existingPerson;
  }

  return person;
}

/**
 * Link a user_profiles row to a person.
 * Sets the person_id FK on the profile.
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
 * Resolve or create a person for the given profile's Slack address,
 * then link the profile to that person. No-op if already linked.
 * Throws on failure — callers should catch if non-fatal.
 */
export async function ensurePersonLinked(profile: {
  id: string;
  slackUserId: string;
  displayName: string | null;
  personId: string | null;
}): Promise<string | null> {
  if (profile.personId) return profile.personId;
  let personId = await resolvePersonByAddress("slack", profile.slackUserId);
  if (!personId) {
    const person = await createPersonWithAddress(
      profile.displayName,
      "slack",
      profile.slackUserId,
      "slack",
    );
    personId = person.id;
  }
  await linkProfileToPerson(profile.id, personId);
  return personId;
}

/**
 * Backfill: for every existing user_profiles row that has no person_id,
 * create a person + slack address, and link the profile.
 * Returns count of profiles linked.
 */
export async function backfillExistingProfiles(): Promise<number> {
  const unlinked = await db
    .select()
    .from(userProfiles)
    .where(isNull(userProfiles.personId));

  let linked = 0;

  for (const profile of unlinked) {
    try {
      await ensurePersonLinked(profile);
      linked++;
    } catch (error) {
      logger.error("Failed to backfill profile", {
        profileId: profile.id,
        slackUserId: profile.slackUserId,
        error: String(error),
      });
    }
  }

  logger.info("Backfill complete", { linked, total: unlinked.length });
  return linked;
}

function normaliseValue(channel: string, value: string): string {
  if (channel === "email" || channel === "phone") {
    return value.toLowerCase();
  }
  return value;
}
