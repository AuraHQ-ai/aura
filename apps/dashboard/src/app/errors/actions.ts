"use server";

import { db } from "@/lib/db";
import { errorEvents } from "@schema";
import { eq, desc, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getErrors(resolved?: string) {
  let query = db
    .select()
    .from(errorEvents)
    .orderBy(desc(errorEvents.timestamp))
    .$dynamic();

  if (resolved === "true") {
    query = query.where(eq(errorEvents.resolved, true));
  } else if (resolved === "false") {
    query = query.where(eq(errorEvents.resolved, false));
  }

  return query.limit(200);
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
