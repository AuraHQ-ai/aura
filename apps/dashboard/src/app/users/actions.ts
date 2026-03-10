"use server";

import { db } from "@/lib/db";
import { userProfiles, people, memories, messages } from "@schema";
import { eq, desc, sql, ilike } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getUsers(search?: string, page = 1, limit = 100) {
  const offset = (page - 1) * limit;
  const where = search ? ilike(userProfiles.displayName, `%${search}%`) : undefined;

  const [{ value: total }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(userProfiles)
    .where(where);

  const items = await db
    .select({
      id: userProfiles.id,
      slackUserId: userProfiles.slackUserId,
      displayName: userProfiles.displayName,
      interactionCount: userProfiles.interactionCount,
      lastInteractionAt: userProfiles.lastInteractionAt,
      createdAt: userProfiles.createdAt,
      personId: userProfiles.personId,
      jobTitle: people.jobTitle,
    })
    .from(userProfiles)
    .leftJoin(people, eq(userProfiles.personId, people.id))
    .where(where)
    .orderBy(desc(userProfiles.lastInteractionAt))
    .limit(limit)
    .offset(offset);

  return { items, total };
}

export async function getUser(slackUserId: string) {
  const [profile] = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.slackUserId, slackUserId));
  if (!profile) return null;

  let person = null;
  if (profile.personId) {
    const [p] = await db.select().from(people).where(eq(people.id, profile.personId));
    person = p ?? null;
  }

  const userMemories = await db
    .select({
      id: memories.id,
      content: memories.content,
      type: memories.type,
      sourceMessageId: memories.sourceMessageId,
      sourceChannelType: memories.sourceChannelType,
      relatedUserIds: memories.relatedUserIds,
      embedding: memories.embedding,
      relevanceScore: memories.relevanceScore,
      shareable: memories.shareable,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .where(sql`${memories.relatedUserIds} @> ARRAY[${slackUserId}]::text[]`)
    .orderBy(desc(memories.createdAt))
    .limit(20);

  return { profile, person, memories: userMemories };
}

export async function updatePerson(
  personId: string,
  data: { jobTitle?: string; preferredLanguage?: string; gender?: string; notes?: string },
) {
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (data.jobTitle !== undefined) values.jobTitle = data.jobTitle;
  if (data.preferredLanguage !== undefined) values.preferredLanguage = data.preferredLanguage;
  if (data.gender !== undefined) values.gender = data.gender;
  if (data.notes !== undefined) values.notes = data.notes;

  await db.update(people).set(values).where(eq(people.id, personId));
  revalidatePath("/users");
}
