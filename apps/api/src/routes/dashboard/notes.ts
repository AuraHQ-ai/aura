import { Hono } from "hono";
import { eq, desc, ilike, count, sql } from "drizzle-orm";
import { notes } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";

export const dashboardNotesApp = new Hono();

dashboardNotesApp.get("/", async (c) => {
  try {
    const search = c.req.query("search");
    const category = c.req.query("category");
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const limit = Math.max(1, Math.min(500, Number(c.req.query("limit")) || 100));
    const offset = (page - 1) * limit;

    const conditions = [];
    if (search) conditions.push(ilike(notes.topic, `%${search}%`));
    if (category) conditions.push(eq(notes.category, category));

    const where = conditions.length > 0
      ? conditions.length === 1
        ? conditions[0]
        : sql`${conditions[0]} AND ${conditions[1]}`
      : undefined;

    const [items, [totalRow]] = await Promise.all([
      db
        .select()
        .from(notes)
        .where(where)
        .orderBy(desc(notes.updatedAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(notes).where(where),
    ]);

    return c.json({ items, total: totalRow.value });
  } catch (error) {
    logger.error("Failed to list notes", { error });
    return c.json({ error: "Failed to list notes" }, 500);
  }
});

dashboardNotesApp.get("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const [note] = await db.select().from(notes).where(eq(notes.id, id));
    if (!note) return c.json({ error: "Note not found" }, 404);
    return c.json(note);
  } catch (error) {
    logger.error("Failed to get note", { error });
    return c.json({ error: "Failed to get note" }, 500);
  }
});

dashboardNotesApp.post("/", async (c) => {
  try {
    const body = await c.req.json<{
      topic: string;
      content: string;
      category: string;
      expiresAt?: string;
    }>();

    const [created] = await db
      .insert(notes)
      .values({
        topic: body.topic,
        content: body.content,
        category: body.category,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      })
      .returning();

    return c.json(created, 201);
  } catch (error) {
    logger.error("Failed to create note", { error });
    return c.json({ error: "Failed to create note" }, 500);
  }
});

dashboardNotesApp.patch("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<{
      topic?: string;
      content?: string;
      category?: string;
      expiresAt?: string | null;
    }>();

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.topic !== undefined) updates.topic = body.topic;
    if (body.content !== undefined) updates.content = body.content;
    if (body.category !== undefined) updates.category = body.category;
    if (body.expiresAt !== undefined)
      updates.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

    const [updated] = await db
      .update(notes)
      .set(updates)
      .where(eq(notes.id, id))
      .returning();

    if (!updated) return c.json({ error: "Note not found" }, 404);
    return c.json(updated);
  } catch (error) {
    logger.error("Failed to update note", { error });
    return c.json({ error: "Failed to update note" }, 500);
  }
});

dashboardNotesApp.delete("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const [deleted] = await db
      .delete(notes)
      .where(eq(notes.id, id))
      .returning({ id: notes.id });

    if (!deleted) return c.json({ error: "Note not found" }, 404);
    return c.json({ ok: true });
  } catch (error) {
    logger.error("Failed to delete note", { error });
    return c.json({ error: "Failed to delete note" }, 500);
  }
});
