import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { defineTool } from "../lib/tool.js";
import { logger } from "../lib/logger.js";
import { db } from "../db/client.js";
import {
  users,
  addresses,
  messages,
  type ScheduleContext,
} from "@aura/db/schema";

// ── Helpers ─────────────────────────────────────────────────────────────────

const SLACK_ID_RE = /^U[A-Z0-9]+$/;
const E164_RE = /^\+[1-9]\d{1,14}$/;

interface RawUserRow {
  id: string;
  workspace_id: string;
  display_name: string;
  slack_user_id: string | null;
  timezone: string | null;
  person_id: string | null;
  job_title: string | null;
  gender: string | null;
  preferred_language: string | null;
  birthdate: string | null;
  manager_id: string | null;
  notes: string | null;
  entity_id: string | null;
  communication_style: Record<string, unknown> | null;
  known_facts: Record<string, unknown> | null;
  role: string;
  interaction_count: number;
  last_interaction_at: string | null;
  last_profile_consolidation: string | null;
  created_at: string;
  updated_at: string;
}

function mapRawUser(row: RawUserRow): typeof users.$inferSelect {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    slackUserId: row.slack_user_id,
    timezone: row.timezone,
    personId: row.person_id,
    jobTitle: row.job_title,
    gender: row.gender,
    preferredLanguage: row.preferred_language,
    birthdate: row.birthdate ? new Date(row.birthdate) : null,
    managerId: row.manager_id,
    notes: row.notes,
    entityId: row.entity_id,
    communicationStyle: row.communication_style,
    knownFacts: row.known_facts,
    role: row.role,
    interactionCount: row.interaction_count,
    lastInteractionAt: row.last_interaction_at ? new Date(row.last_interaction_at) : null,
    lastProfileConsolidation: row.last_profile_consolidation ? new Date(row.last_profile_consolidation) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  } as typeof users.$inferSelect;
}

interface PersonResult {
  id: string;
  display_name: string;
  slack_user_id: string | null;
  job_title: string | null;
  gender: string | null;
  preferred_language: string | null;
  birthdate: string | null;
  manager_id: string | null;
  manager_name: string | null;
  notes: string | null;
  addresses: { id: string; channel: string; value: string; is_primary: boolean }[];
  stats: {
    workspace_messages: number;
    aura_dm_messages: number;
    last_activity: string | null;
    last_aura_dm: string | null;
    profile_created: string | null;
  };
}

async function enrichPerson(user: typeof users.$inferSelect): Promise<PersonResult> {
  const addrs = await db
    .select({
      id: addresses.id,
      channel: addresses.channel,
      value: addresses.value,
      isPrimary: addresses.isPrimary,
    })
    .from(addresses)
    .where(eq(addresses.userId, user.id));

  let managerName: string | null = null;
  if (user.managerId) {
    const [mgr] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.slackUserId, user.managerId))
      .limit(1);
    managerName = mgr?.displayName ?? null;
  }

  let workspaceMessages = 0;
  let auraDmMessages = 0;
  let lastActivity: string | null = null;
  let lastAuraDm: string | null = null;
  const profileCreated = user.createdAt.toISOString();

  if (user.slackUserId) {
    const [msgStats] = await db
      .select({
        lastTs: sql<string>`max(${messages.createdAt})`,
        workspaceMessages: sql<number>`count(*) filter (where ${messages.channelType} != 'dm')`,
        auraDmMessages: sql<number>`count(*) filter (where ${messages.channelType} = 'dm')`,
        lastAuraDm: sql<string>`max(${messages.createdAt}) filter (where ${messages.channelType} = 'dm')`,
      })
      .from(messages)
      .where(eq(messages.userId, user.slackUserId));

    workspaceMessages = Number(msgStats?.workspaceMessages ?? 0);
    auraDmMessages = Number(msgStats?.auraDmMessages ?? 0);
    lastActivity = msgStats?.lastTs ?? null;
    lastAuraDm = msgStats?.lastAuraDm ?? null;
  }

  return {
    id: user.id,
    display_name: user.displayName,
    slack_user_id: user.slackUserId,
    job_title: user.jobTitle ?? null,
    gender: user.gender ?? null,
    preferred_language: user.preferredLanguage ?? null,
    birthdate: user.birthdate ? user.birthdate.toISOString().split("T")[0] : null,
    manager_id: user.managerId ?? null,
    manager_name: managerName,
    notes: user.notes ?? null,
    addresses: addrs.map((a) => ({
      id: a.id,
      channel: a.channel,
      value: a.value,
      is_primary: a.isPrimary,
    })),
    stats: {
      workspace_messages: workspaceMessages,
      aura_dm_messages: auraDmMessages,
      last_activity: lastActivity,
      last_aura_dm: lastAuraDm,
      profile_created: profileCreated,
    },
  };
}

async function findPeople(query: string): Promise<(typeof users.$inferSelect)[]> {
  if (SLACK_ID_RE.test(query)) {
    return db
      .select()
      .from(users)
      .where(eq(users.slackUserId, query))
      .limit(1);
  }

  if (query.includes("@")) {
    const rows = await db
      .select({ user: users })
      .from(addresses)
      .innerJoin(users, eq(addresses.userId, users.id))
      .where(and(eq(addresses.channel, "email"), eq(addresses.value, query.toLowerCase())))
      .limit(1);
    return rows.map((r) => r.user);
  }

  const rows = await db.execute(sql`
    SELECT u.*
    FROM users u
    WHERE similarity(u.display_name, ${query}) > 0.3
    ORDER BY similarity(u.display_name, ${query}) DESC
    LIMIT 3
  `);

  const rawRows = ((rows as any).rows ?? rows) as RawUserRow[];
  return rawRows.map(mapRawUser);
}

// ── Tool Definitions ────────────────────────────────────────────────────────

export function createPeopleTools(context?: ScheduleContext) {
  return {
    get_person: defineTool({
      description:
        "Look up a person in the users database by name, Slack user ID (e.g. 'U0678NQJ2'), or email address. " +
        "Returns structured profile data including job title, gender, preferred language, birthdate, manager, notes/context, " +
        "all known addresses (email, phone, slack), and Slack activity stats (workspace_messages, aura_dm_messages, last_activity, last_aura_dm). " +
        "Use this before update_person to confirm identity. For ambiguous name searches, returns up to 3 fuzzy matches.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Name, Slack user ID (e.g. 'U0678NQJ2'), or email to search for",
          ),
      }),
      execute: async ({ query }) => {
        try {
          const matched = await findPeople(query.trim());

          if (matched.length === 0) {
            return { ok: false as const, error: `No person found matching '${query}'` };
          }

          const results = await Promise.all(matched.map(enrichPerson));

          logger.info("get_person tool called", {
            query,
            matchCount: results.length,
          });

          return { ok: true as const, people: results, count: results.length };
        } catch (error: any) {
          logger.error("get_person tool failed", { query, error: error.message });
          return { ok: false as const, error: `Failed to look up person: ${error.message}` };
        }
      },
      slack: {
        status: "Looking up person...",
        detail: (i) => i.query?.slice(0, 40),
        output: (r) =>
          r.ok === false
            ? r.error
            : `${r.count} match${r.count === 1 ? "" : "es"} found`,
      },
    }),

    update_person: defineTool({
      description:
        "Update a person's profile in the users database. Identify the person by person_id (UUID) or query (fuzzy name/Slack ID/email lookup — must resolve to exactly 1 person). " +
        "Can update fields (display_name, job_title, gender, preferred_language, birthdate, manager_id, notes), " +
        "add or remove addresses, and use phone/email shorthands to upsert primary contact info. " +
        "Always use get_person first to verify identity before updating.",
      inputSchema: z.object({
        person_id: z
          .string()
          .uuid()
          .optional()
          .describe("UUID of the user to update"),
        query: z
          .string()
          .optional()
          .describe(
            "Fuzzy lookup (name, Slack ID, or email). Must resolve to exactly 1 person. Use person_id when possible.",
          ),
        fields: z
          .object({
            display_name: z.string().optional(),
            job_title: z.string().optional(),
            gender: z.enum(["male", "female"]).optional(),
            preferred_language: z.enum(["en", "fr", "es", "it", "de", "pt"]).optional(),
            birthdate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
              .optional(),
            manager_id: z
              .string()
              .optional()
              .describe("Slack user ID or name of the manager"),
            notes: z
              .string()
              .optional()
              .describe("Free-text notes/context about this person"),
            phone: z
              .string()
              .regex(E164_RE, "Must be E.164 format, e.g. +14155551234")
              .optional()
              .describe("Upsert primary phone address"),
            email: z
              .string()
              .email()
              .optional()
              .describe("Upsert primary email address"),
          })
          .optional()
          .describe("Fields to update on the user record"),
        add_address: z
          .object({
            channel: z.string(),
            value: z.string(),
            is_primary: z.boolean().optional(),
          })
          .optional()
          .describe("Add a new address (channel + value)"),
        remove_address: z
          .object({
            channel: z.string(),
            value: z.string(),
          })
          .optional()
          .describe("Remove an address by channel + value"),
      }),
      execute: async ({ person_id, query, fields, add_address, remove_address }) => {
        try {
          if (!person_id && !query) {
            return { ok: false as const, error: "Provide either person_id or query to identify the person" };
          }

          let resolvedId: string;

          if (person_id) {
            const [exists] = await db
              .select({ id: users.id })
              .from(users)
              .where(eq(users.id, person_id))
              .limit(1);
            if (!exists) {
              return { ok: false as const, error: `Person ${person_id} not found` };
            }
            resolvedId = person_id;
          } else {
            const matched = await findPeople(query!.trim());
            if (matched.length === 0) {
              return { ok: false as const, error: `No person found matching '${query}'` };
            }
            if (matched.length > 1) {
              const names = matched.map((p: any) => p.displayName || p.id).join(", ");
              return {
                ok: false as const,
                error: `Ambiguous match: found ${matched.length} people (${names}). Use person_id or a more specific query.`,
              };
            }
            resolvedId = (matched[0] as any).id;
          }

          const updateSet: Record<string, unknown> = { updatedAt: new Date() };

          if (fields) {
            if (fields.display_name !== undefined) updateSet.displayName = fields.display_name;
            if (fields.job_title !== undefined) updateSet.jobTitle = fields.job_title;
            if (fields.gender !== undefined) updateSet.gender = fields.gender;
            if (fields.preferred_language !== undefined) updateSet.preferredLanguage = fields.preferred_language;
            if (fields.birthdate !== undefined) updateSet.birthdate = new Date(fields.birthdate);

            if (fields.manager_id !== undefined) {
              if (SLACK_ID_RE.test(fields.manager_id)) {
                updateSet.managerId = fields.manager_id;
              } else {
                const mgrMatches = await findPeople(fields.manager_id);
                if (mgrMatches.length === 0) {
                  return { ok: false as const, error: `Could not resolve manager '${fields.manager_id}'` };
                }
                if (mgrMatches.length > 1) {
                  const names = mgrMatches.map((p: any) => p.displayName || p.id).join(", ");
                  return {
                    ok: false as const,
                    error: `Ambiguous manager match: found ${mgrMatches.length} people (${names}). Use a Slack user ID instead.`,
                  };
                }
                const resolvedSlackId = (mgrMatches[0] as any).slackUserId;
                if (!resolvedSlackId) {
                  return { ok: false as const, error: `Resolved manager '${fields.manager_id}' has no Slack user ID. Use their Slack user ID directly.` };
                }
                updateSet.managerId = resolvedSlackId;
              }
            }

            if (fields.notes !== undefined) updateSet.notes = fields.notes;

            if (fields.phone !== undefined) {
              await upsertPrimaryAddress(resolvedId, "phone", fields.phone.toLowerCase());
            }
            if (fields.email !== undefined) {
              await upsertPrimaryAddress(resolvedId, "email", fields.email.toLowerCase());
            }
          }

          if (add_address) {
            const normalizedValue =
              add_address.channel === "email"
                ? add_address.value.toLowerCase()
                : add_address.value;

            const existingAddr = await db
              .select()
              .from(addresses)
              .where(
                and(
                  eq(addresses.channel, add_address.channel),
                  eq(addresses.value, normalizedValue),
                ),
              )
              .limit(1);

            if (existingAddr.length > 0 && existingAddr[0].userId !== resolvedId) {
              throw new Error(
                `Address ${normalizedValue} is already assigned to another person`,
              );
            }

            if (existingAddr.length === 0) {
              await db.insert(addresses).values({
                userId: resolvedId,
                channel: add_address.channel,
                value: normalizedValue,
                isPrimary: add_address.is_primary ?? false,
              });
            } else if (add_address.is_primary && !existingAddr[0].isPrimary) {
              await db
                .update(addresses)
                .set({ isPrimary: true })
                .where(eq(addresses.id, existingAddr[0].id));
            }
          }

          if (remove_address) {
            const normalizedRemoveValue =
              remove_address.channel === "email"
                ? remove_address.value.toLowerCase()
                : remove_address.value;

            await db
              .delete(addresses)
              .where(
                and(
                  eq(addresses.userId, resolvedId),
                  eq(addresses.channel, remove_address.channel),
                  eq(addresses.value, normalizedRemoveValue),
                ),
              );
          }

          await db
            .update(users)
            .set(updateSet)
            .where(eq(users.id, resolvedId));

          const [updated] = await db
            .select()
            .from(users)
            .where(eq(users.id, resolvedId))
            .limit(1);

          if (!updated) {
            return { ok: false as const, error: `Person ${resolvedId} not found after update` };
          }

          const result = await enrichPerson(updated);

          logger.info("update_person tool called", {
            personId: resolvedId,
            fieldsUpdated: fields ? Object.keys(fields) : [],
            addedAddress: !!add_address,
            removedAddress: !!remove_address,
          });

          return { ok: true as const, person: result };
        } catch (error: any) {
          logger.error("update_person tool failed", {
            person_id,
            query,
            error: error.message,
          });
          return { ok: false as const, error: `Failed to update person: ${error.message}` };
        }
      },
      slack: {
        status: "Updating person record...",
        detail: (i) => i.query?.slice(0, 40) || i.person_id?.slice(0, 8),
        output: (r) =>
          r.ok === false
            ? r.error
            : `Updated ${r.person?.display_name || "person"}`,
      },
    }),
  };
}

async function upsertPrimaryAddress(
  userId: string,
  channel: string,
  value: string,
): Promise<void> {
  const existing = await db
    .select()
    .from(addresses)
    .where(
      and(
        eq(addresses.userId, userId),
        eq(addresses.channel, channel),
        eq(addresses.isPrimary, true),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    if (existing[0].value === value) return;

    const conflict = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.channel, channel), eq(addresses.value, value)))
      .limit(1);

    if (conflict.length > 0) {
      if (conflict[0].userId !== userId) {
        throw new Error(`Address ${value} is already assigned to another person`);
      }
      await db.delete(addresses).where(eq(addresses.id, existing[0].id));
      await db
        .update(addresses)
        .set({ isPrimary: true })
        .where(eq(addresses.id, conflict[0].id));
    } else {
      await db
        .update(addresses)
        .set({ value, isPrimary: true })
        .where(eq(addresses.id, existing[0].id));
    }
  } else {
    const byChannelValue = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.channel, channel), eq(addresses.value, value)))
      .limit(1);

    if (byChannelValue.length > 0) {
      if (byChannelValue[0].userId === userId) {
        await db
          .update(addresses)
          .set({ isPrimary: true })
          .where(eq(addresses.id, byChannelValue[0].id));
      } else {
        throw new Error(`Address ${value} is already assigned to another person`);
      }
    } else {
      await db
        .insert(addresses)
        .values({ userId, channel, value, isPrimary: true });
    }
  }
}
