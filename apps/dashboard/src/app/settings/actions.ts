"use server";

import { db } from "@/lib/db";
import { settings } from "@schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getSettings() {
  return db.select().from(settings).orderBy(settings.key);
}

export async function getSetting(key: string) {
  const [setting] = await db.select().from(settings).where(eq(settings.key, key));
  return setting?.value ?? null;
}

export async function setSetting(key: string, value: string) {
  await db
    .insert(settings)
    .values({ key, value, updatedAt: new Date(), updatedBy: "dashboard" })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date(), updatedBy: "dashboard" },
    });
  revalidatePath("/settings");
}
