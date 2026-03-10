"use server";

import { db } from "@/lib/db";
import { notes } from "@schema";
import { eq, desc, ilike, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getNotes(search?: string, category?: string, page = 1, limit = 100) {
  const offset = (page - 1) * limit;

  const conditions = [];
  if (search) conditions.push(ilike(notes.topic, `%${search}%`));
  if (category) conditions.push(eq(notes.category, category));

  const where = conditions.length ? sql`${sql.join(conditions, sql` AND `)}` : undefined;

  const [{ value: total }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(notes)
    .where(where);

  const items = await db
    .select()
    .from(notes)
    .where(where)
    .orderBy(desc(notes.updatedAt))
    .limit(limit)
    .offset(offset);

  return { items, total };
}

export async function getNote(id: string) {
  const [note] = await db.select().from(notes).where(eq(notes.id, id));
  return note ?? null;
}

export async function createNote(data: { topic: string; content: string; category: string; expiresAt?: string }) {
  const [note] = await db
    .insert(notes)
    .values({
      topic: data.topic,
      content: data.content,
      category: data.category,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    })
    .returning();
  revalidatePath("/notes");
  return note;
}

export async function updateNote(id: string, data: { topic?: string; content?: string; category?: string; expiresAt?: string | null }) {
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (data.topic !== undefined) values.topic = data.topic;
  if (data.content !== undefined) values.content = data.content;
  if (data.category !== undefined) values.category = data.category;
  if (data.expiresAt !== undefined) values.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;

  await db.update(notes).set(values).where(eq(notes.id, id));
  revalidatePath("/notes");
  revalidatePath(`/notes/${id}`);
}

export async function deleteNote(id: string) {
  await db.delete(notes).where(eq(notes.id, id));
  revalidatePath("/notes");
}
