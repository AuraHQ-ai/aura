"use server";

import { db } from "@/lib/db";
import { memories, userProfiles } from "@schema";
import { eq, desc, sql, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getMemories(search?: string, type?: string) {
  let query = db
    .select()
    .from(memories)
    .orderBy(desc(memories.createdAt))
    .$dynamic();

  if (type) {
    query = query.where(eq(memories.type, type as any));
  }

  const results = await query.limit(200);

  if (search) {
    const filtered = results.filter((m) =>
      m.content.toLowerCase().includes(search.toLowerCase()),
    );
    return filtered;
  }

  return results;
}

export async function searchMemoriesKeyword(query: string) {
  const results = await db
    .select()
    .from(memories)
    .where(sql`to_tsvector('english', coalesce(${memories.content}, '')) @@ plainto_tsquery('english', ${query})`)
    .orderBy(desc(memories.relevanceScore))
    .limit(50);
  return results;
}

export async function getMemory(id: string) {
  const [memory] = await db.select().from(memories).where(eq(memories.id, id));
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
