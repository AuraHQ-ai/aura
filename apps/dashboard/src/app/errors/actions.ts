"use server";

import { db } from "@/lib/db";
import { errorEvents } from "@schema";
import { eq, desc, inArray, ilike, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getErrors(resolved?: string, search?: string, page = 1, limit = 100) {
  const offset = (page - 1) * limit;

  const conditions = [];
  if (resolved === "true") conditions.push(eq(errorEvents.resolved, true));
  else if (resolved === "false") conditions.push(eq(errorEvents.resolved, false));
  if (search) conditions.push(ilike(errorEvents.errorName, `%${search}%`));

  const where = conditions.length ? sql`${sql.join(conditions, sql` AND `)}` : undefined;

  const [{ value: total }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(errorEvents)
    .where(where);

  const items = await db
    .select()
    .from(errorEvents)
    .where(where)
    .orderBy(desc(errorEvents.timestamp))
    .limit(limit)
    .offset(offset);

  return { items, total };
}

export async function getError(id: string) {
  const [err] = await db.select().from(errorEvents).where(eq(errorEvents.id, id));
  return err ?? null;
}

export async function resolveErrors(ids: string[]) {
  if (ids.length === 0) return;
  await db
    .update(errorEvents)
    .set({ resolved: true })
    .where(inArray(errorEvents.id, ids));
  revalidatePath("/errors");
}
