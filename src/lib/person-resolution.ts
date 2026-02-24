import { generateObject } from "ai";
import { z } from "zod";
import { eq, and, isNull, ilike, sql, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  people,
  addresses,
  userProfiles,
  emailsRaw,
  type Person,
  type Address,
} from "../db/schema.js";
import { getFastModel } from "./ai.js";
import { logger } from "./logger.js";

// Configurable internal domain for fuzzy-matching team members
const INTERNAL_DOMAIN = process.env.INTERNAL_EMAIL_DOMAIN || "realadvisor.com";

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
    const existingPersonId = await resolvePersonByAddress(channel, value);
    if (existingPersonId) {
      await db.delete(people).where(eq(people.id, person.id));
      const [existingPerson] = await db
        .select()
        .from(people)
        .where(eq(people.id, existingPersonId))
        .limit(1);
      return existingPerson;
    }
    // Address exists but has no person — claim it for the new person
    await db
      .update(addresses)
      .set({ personId: person.id })
      .where(
        and(eq(addresses.channel, channel), eq(addresses.value, normalised)),
      );
    return person;
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

/**
 * Resolve or create a person for a given email address.
 * 1. Check if the email already maps to a person via addresses table.
 *    - If found and discarded → return null (skip, no person creation)
 *    - If found and linked to a person → return that person_id
 * 2. For emails matching the internal domain (INTERNAL_EMAIL_DOMAIN env var), try fuzzy-matching the name part against
 *    existing people display names (avoids duplicating internal team members).
 * 3. Otherwise, create a new person with the email address as a fallback pending clustering.
 * Returns the person ID, or null if the address is discarded.
 */
export async function resolveOrCreateFromEmail(
  email: string,
  displayName: string | null,
  source = "email_header",
): Promise<string | null> {
  const normEmail = email.toLowerCase();

  const existingRows = await db
    .select({
      personId: addresses.personId,
      isDiscarded: addresses.isDiscarded,
    })
    .from(addresses)
    .where(and(eq(addresses.channel, "email"), eq(addresses.value, normEmail)))
    .limit(1);

  if (existingRows.length > 0) {
    const row = existingRows[0];
    if (row.isDiscarded) return null;
    if (row.personId) return row.personId;
  }

  if (normEmail.endsWith(`@${INTERNAL_DOMAIN}`)) {
    const namePart = normEmail.split("@")[0];
    if (namePart) {
      const fuzzyMatches = await db
        .select({ id: people.id })
        .from(people)
        .where(ilike(people.displayName, `%${namePart}%`))
        .limit(1);

      if (fuzzyMatches.length > 0) {
        const matchedPersonId = fuzzyMatches[0].id;
        await db
          .insert(addresses)
          .values({
            personId: matchedPersonId,
            channel: "email",
            value: normEmail,
            source,
            confidence: 0.9,
          })
          .onConflictDoNothing();
        logger.info("Linked internal domain email to existing person via fuzzy match", {
          email: normEmail,
          personId: matchedPersonId,
        });
        return matchedPersonId;
      }
    }
  }

  if (existingRows.length > 0) {
    // Existing address with null personId — create a person and link it
    const [person] = await db
      .insert(people)
      .values({ displayName })
      .returning();
    await db
      .update(addresses)
      .set({ personId: person.id, source })
      .where(
        and(eq(addresses.channel, "email"), eq(addresses.value, normEmail)),
      );
    return person.id;
  }

  const person = await createPersonWithAddress(
    displayName,
    "email",
    normEmail,
    source,
  );
  return person.id;
}

/**
 * Backfill: find all distinct email senders in emails_raw that don't have
 * a corresponding address record, and resolve/create a person for each.
 * Returns the count of senders processed.
 */
export async function backfillEmailSenders(): Promise<number> {
  const unresolved = await db
    .selectDistinctOn([emailsRaw.fromEmail], {
      fromEmail: emailsRaw.fromEmail,
      fromName: emailsRaw.fromName,
    })
    .from(emailsRaw)
    .where(
      sql`${emailsRaw.fromEmail} NOT IN (
        SELECT ${addresses.value} FROM ${addresses} WHERE ${addresses.channel} = 'email'
      )`,
    );

  let processed = 0;

  for (const row of unresolved) {
    try {
      await resolveOrCreateFromEmail(row.fromEmail, row.fromName);
      processed++;
    } catch (error) {
      logger.error("Failed to backfill email sender", {
        email: row.fromEmail,
        error: String(error),
      });
    }
  }

  logger.info("Email sender backfill complete", {
    processed,
    total: unresolved.length,
  });
  return processed;
}

// ── Identity clustering ─────────────────────────────────────────────────────

const CLUSTER_BATCH_SIZE = 60;

const clusterSchema = z.object({
  groups: z.array(
    z.object({
      displayName: z.string(),
      type: z.enum(["person", "organization"]),
      addressIds: z.array(z.string()),
    }),
  ),
  discards: z.array(
    z.object({
      addressId: z.string(),
      reason: z.string(),
    }),
  ),
});

const CLUSTER_SYSTEM_PROMPT = `You are an identity resolution system. Given a list of communication addresses (email, slack, phone), group them into distinct people or entities.

Rules:
- System/bot addresses (noreply@, notifications@, alerts@, *-noreply@, do-not-reply@) should be DISCARDED, not grouped into people
- Newsletter/marketing addresses should be DISCARDED
- Multiple addresses from the same person should be in ONE group (e.g. joan@realadvisor.com and rodriguezjoan@gmail.com are the same person if the names match)
- Google Docs/Drive notification emails (via Google Docs) are NOT the person named — DISCARD them
- Company notification addresses (e.g. hello@browserbase.com, notifications@github.com) should be DISCARDED unless they clearly represent a real person writing personally
- A Slack user ID and an email can belong to the same person if the display names match closely

For each group, provide:
- A display_name for the person
- The list of address IDs in the group
- Whether this is a "person" or "organization"

For each discard, provide:
- The address ID
- The reason for discarding`;

/**
 * Load unclustered addresses and batch them to Haiku for identity clustering.
 * Creates people rows for each cluster and marks discards.
 * Returns stats about the run.
 */
export async function distillPeopleFromAddresses(): Promise<{
  grouped: number;
  discarded: number;
  peopleCreated: number;
}> {
  const unclustered = await db
    .select()
    .from(addresses)
    .where(and(isNull(addresses.personId), eq(addresses.isDiscarded, false)));

  if (unclustered.length === 0) {
    logger.info("No unclustered addresses to process");
    return { grouped: 0, discarded: 0, peopleCreated: 0 };
  }

  logger.info("Starting identity clustering", { totalAddresses: unclustered.length });

  const model = await getFastModel();
  let totalGrouped = 0;
  let totalDiscarded = 0;
  let totalPeopleCreated = 0;

  for (let i = 0; i < unclustered.length; i += CLUSTER_BATCH_SIZE) {
    const batch = unclustered.slice(i, i + CLUSTER_BATCH_SIZE);

    const addressList = batch.map((a) => {
      const isInternalSource =
        !a.source || a.source.startsWith("auto-created-");
      return {
        id: a.id,
        channel: a.channel,
        value: a.value,
        displayName: isInternalSource ? undefined : a.source,
      };
    });

    try {
      const { object } = await generateObject({
        model,
        schema: clusterSchema,
        system: CLUSTER_SYSTEM_PROMPT,
        prompt: `Cluster these ${batch.length} addresses:\n${JSON.stringify(addressList, null, 2)}`,
        maxOutputTokens: 4096,
      });

      const batchAddressIds = new Set(batch.map((a) => a.id));

      for (const group of object.groups) {
        const validIds = group.addressIds.filter((id) => batchAddressIds.has(id));
        if (validIds.length === 0) continue;

        const [person] = await db
          .insert(people)
          .values({ displayName: group.displayName, type: group.type })
          .returning();

        await db
          .update(addresses)
          .set({ personId: person.id })
          .where(inArray(addresses.id, validIds));

        totalGrouped += validIds.length;
        totalPeopleCreated++;
      }

      for (const discard of object.discards) {
        if (!batchAddressIds.has(discard.addressId)) continue;

        await db
          .update(addresses)
          .set({ isDiscarded: true, discardReason: discard.reason })
          .where(eq(addresses.id, discard.addressId));

        totalDiscarded++;
      }

      logger.info("Processed clustering batch", {
        batchIndex: Math.floor(i / CLUSTER_BATCH_SIZE),
        groups: object.groups.length,
        discards: object.discards.length,
      });
    } catch (error) {
      logger.error("Failed to cluster batch", {
        batchIndex: Math.floor(i / CLUSTER_BATCH_SIZE),
        batchSize: batch.length,
        error: String(error),
      });
    }
  }

  logger.info("Identity clustering complete", {
    grouped: totalGrouped,
    discarded: totalDiscarded,
    peopleCreated: totalPeopleCreated,
  });

  return {
    grouped: totalGrouped,
    discarded: totalDiscarded,
    peopleCreated: totalPeopleCreated,
  };
}

// Manual address overrides — set via MANUAL_ADDRESSES_JSON env var
const MANUAL_ADDRESSES: Array<{
  name: string;
  addresses: Array<{ channel: string; value: string }>;
}> = [];

/**
 * Full rebuild of the people table using Haiku-powered identity clustering.
 * 1. Nulls out user_profiles.person_id
 * 2. Deletes all addresses and people
 * 3. Re-inserts addresses from source data (Slack profiles, email senders, manual, directory)
 * 4. Runs distillPeopleFromAddresses() to cluster
 * 5. Re-links user_profiles to their new person records
 */
export async function rebuildPeopleFromScratch(): Promise<{
  addressesInserted: number;
  clusterResult: { grouped: number; discarded: number; peopleCreated: number };
  profilesLinked: number;
}> {
  logger.info("Starting full people table rebuild");

  // 1. Null out user_profiles.person_id (must happen before deleting people
  //    to avoid losing profiles — TRUNCATE CASCADE would wipe user_profiles too)
  await db
    .update(userProfiles)
    .set({ personId: null, updatedAt: new Date() })
    .where(sql`${userProfiles.personId} IS NOT NULL`);

  // 2. Delete addresses then people (avoids TRUNCATE CASCADE which would
  //    also truncate user_profiles via its FK to people)
  await db.delete(addresses);
  await db.delete(people);

  let addressesInserted = 0;

  // 3a. Insert Slack addresses from user_profiles
  const profiles = await db.select().from(userProfiles);
  for (const profile of profiles) {
    try {
      const inserted = await db
        .insert(addresses)
        .values({
          channel: "slack",
          value: profile.slackUserId,
          source: profile.displayName,
        })
        .onConflictDoNothing()
        .returning();
      addressesInserted += inserted.length;
    } catch (error) {
      logger.error("Failed to insert Slack address", {
        slackUserId: profile.slackUserId,
        error: String(error),
      });
    }
  }

  // 3b. Insert email addresses from emails_raw (distinct senders)
  const emailSenders = await db
    .selectDistinctOn([emailsRaw.fromEmail], {
      fromEmail: emailsRaw.fromEmail,
      fromName: emailsRaw.fromName,
    })
    .from(emailsRaw);

  for (const sender of emailSenders) {
    try {
      const inserted = await db
        .insert(addresses)
        .values({
          channel: "email",
          value: sender.fromEmail.toLowerCase(),
          source: sender.fromName,
        })
        .onConflictDoNothing()
        .returning();
      addressesInserted += inserted.length;
    } catch (error) {
      logger.error("Failed to insert email address", {
        email: sender.fromEmail,
        error: String(error),
      });
    }
  }

  // 3c. Insert manual address overrides
  const manualOverrides = process.env.MANUAL_ADDRESSES_JSON
    ? (JSON.parse(process.env.MANUAL_ADDRESSES_JSON) as typeof MANUAL_ADDRESSES)
    : MANUAL_ADDRESSES;

  for (const entry of manualOverrides) {
    for (const addr of entry.addresses) {
      try {
        const inserted = await db
          .insert(addresses)
          .values({
            channel: addr.channel,
            value: normaliseValue(addr.channel, addr.value),
            source: entry.name,
          })
          .onConflictDoNothing()
          .returning();
        addressesInserted += inserted.length;
      } catch (error) {
        logger.error("Failed to insert manual address", {
          name: entry.name,
          channel: addr.channel,
          value: addr.value,
          error: String(error),
        });
      }
    }
  }

  // 3d. Try Google Workspace directory for internal team emails
  try {
    const { listDirectoryUsers } = await import("./workspace-directory.js");
    const directoryUsers = await listDirectoryUsers();
    if (directoryUsers) {
      for (const user of directoryUsers) {
        try {
          const inserted = await db
            .insert(addresses)
            .values({
              channel: "email",
              value: user.email.toLowerCase(),
              source: user.name,
            })
            .onConflictDoNothing()
            .returning();
          addressesInserted += inserted.length;
        } catch (error) {
          logger.error("Failed to insert directory email", {
            email: user.email,
            error: String(error),
          });
        }
      }
    }
  } catch (error) {
    logger.warn("Google Workspace directory unavailable, skipping", {
      error: String(error),
    });
  }

  logger.info("Address re-insertion complete", { addressesInserted });

  // 4. Run clustering
  const clusterResult = await distillPeopleFromAddresses();

  // 5. Re-link user_profiles to people via their Slack addresses
  let profilesLinked = 0;
  const allProfiles = await db.select().from(userProfiles);

  for (const profile of allProfiles) {
    const linked = await db
      .select({ personId: addresses.personId })
      .from(addresses)
      .where(
        and(
          eq(addresses.channel, "slack"),
          eq(addresses.value, profile.slackUserId),
          sql`${addresses.personId} IS NOT NULL`,
        ),
      )
      .limit(1);

    if (linked.length > 0 && linked[0].personId) {
      await db
        .update(userProfiles)
        .set({ personId: linked[0].personId, updatedAt: new Date() })
        .where(eq(userProfiles.id, profile.id));
      profilesLinked++;
    }
  }

  logger.info("People rebuild complete", {
    addressesInserted,
    clusterResult,
    profilesLinked,
  });

  return { addressesInserted, clusterResult, profilesLinked };
}

function normaliseValue(channel: string, value: string): string {
  if (channel === "email" || channel === "phone") {
    return value.toLowerCase();
  }
  return value;
}
