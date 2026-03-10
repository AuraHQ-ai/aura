"use server";

import { db } from "@/lib/db";
import { notes } from "@schema";
import { eq, desc, ilike, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getNotes(search?: string, category?: string) {
  let query = db
    .select()
    .from(notes)
    .orderBy(desc(notes.updatedAt))
    .$dynamic();

  if (search) {
    query = query.where(ilike(notes.topic, `%${search}%`));
  }
  if (category) {
    query = query.where(eq(notes.category, category));
  }

  return query.limit(200);
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
