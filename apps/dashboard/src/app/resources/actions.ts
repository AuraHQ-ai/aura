"use server";

import { db } from "@/lib/db";
import { resources } from "@schema";
import { eq, desc, ilike, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getResources(source?: string, status?: string, search?: string, page = 1, limit = 100) {
  const offset = (page - 1) * limit;

  const conditions = [];
  if (source) conditions.push(eq(resources.source, source));
  if (status) conditions.push(eq(resources.status, status as any));
  if (search) conditions.push(ilike(resources.title, `%${search}%`));

  const where = conditions.length ? sql`${sql.join(conditions, sql` AND `)}` : undefined;

  const [{ value: total }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(resources)
    .where(where);

  const items = await db
    .select()
    .from(resources)
    .where(where)
    .orderBy(desc(resources.updatedAt))
    .limit(limit)
    .offset(offset);

  return { items, total };
}

export async function getResource(id: string) {
  const [resource] = await db.select().from(resources).where(eq(resources.id, id));
  return resource ?? null;
}

export async function deleteResource(id: string) {
  await db.delete(resources).where(eq(resources.id, id));
  revalidatePath("/resources");
}
