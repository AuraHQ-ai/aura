"use server";

import { db } from "@/lib/db";
import { resources } from "@schema";
import { eq, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getResources(source?: string, status?: string) {
  let query = db
    .select()
    .from(resources)
    .orderBy(desc(resources.updatedAt))
    .$dynamic();

  if (source) {
    query = query.where(eq(resources.source, source));
  }
  if (status) {
    query = query.where(eq(resources.status, status as any));
  }

  return query.limit(200);
}

export async function getResource(id: string) {
  const [resource] = await db.select().from(resources).where(eq(resources.id, id));
  return resource ?? null;
}

export async function deleteResource(id: string) {
  await db.delete(resources).where(eq(resources.id, id));
  revalidatePath("/resources");
}
