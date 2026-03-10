"use server";

import { db } from "@/lib/db";
import { memories, userProfiles } from "@schema";
import { eq, desc, sql, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

const memoryCols = {
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
};

export async function getMemories(search?: string, type?: string, page = 1, limit = 100) {
  const offset = (page - 1) * limit;

  const conditions = [];
  if (type) conditions.push(eq(memories.type, type as any));
  if (search) conditions.push(sql`to_tsvector('english', coalesce(${memories.content}, '')) @@ plainto_tsquery('english', ${search})`);

  const where = conditions.length ? sql`${sql.join(conditions, sql` AND `)}` : undefined;

  const [{ value: total }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(memories)
    .where(where);

  const items = await db
    .select(memoryCols)
    .from(memories)
    .where(where)
    .orderBy(desc(memories.createdAt))
    .limit(limit)
    .offset(offset);

  return { items, total };
}

export async function searchMemoriesKeyword(query: string) {
  return db
    .select(memoryCols)
    .from(memories)
    .where(sql`to_tsvector('english', coalesce(${memories.content}, '')) @@ plainto_tsquery('english', ${query})`)
    .orderBy(desc(memories.relevanceScore))
    .limit(50);
}

export async function getMemory(id: string) {
  const [memory] = await db.select(memoryCols).from(memories).where(eq(memories.id, id));
  if (!memory) return null;

  let relatedUsers: { slackUserId: string; displayName: string }[] = [];
  if (memory.relatedUserIds.length > 0) {
    relatedUsers = await db
      .select({ slackUserId: userProfiles.slackUserId, displayName: userProfiles.displayName })
      .from(userProfiles)
      .where(inArray(userProfiles.slackUserId, memory.relatedUserIds));
  }

  return { ...memory, relatedUsers };
}

export async function updateMemory(
  id: string,
  data: { content?: string; relevanceScore?: number; shareable?: number },
) {
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (data.content !== undefined) values.content = data.content;
  if (data.relevanceScore !== undefined) values.relevanceScore = data.relevanceScore;
  if (data.shareable !== undefined) values.shareable = data.shareable;

  await db.update(memories).set(values).where(eq(memories.id, id));
  revalidatePath("/memories");
  revalidatePath(`/memories/${id}`);
}

export async function deleteMemory(id: string) {
  await db.delete(memories).where(eq(memories.id, id));
  revalidatePath("/memories");
}
