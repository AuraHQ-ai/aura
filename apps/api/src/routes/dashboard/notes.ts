import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, desc, ilike, count, sql } from "drizzle-orm";
import { notes } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, idParamSchema } from "./schemas.js";

export const dashboardNotesApp = new OpenAPIHono();

const listNotesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Notes"],
  summary: "List notes",
  request: {
    query: z.object({
      search: z.string().optional(),
      category: z.string().optional(),
      page: z.coerce.number().optional(),
      limit: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(z.any()),
            total: z.number(),
          }),
        },
      },
      description: "Success",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardNotesApp.openapi(listNotesRoute, async (c) => {
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

    return c.json({ items, total: totalRow.value } as any, 200);
  } catch (error) {
    logger.error("Failed to list notes", { error });
    return c.json({ error: "Failed to list notes" }, 500);
  }
});

const getNoteRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Notes"],
  summary: "Get a note by ID",
  request: {
    params: idParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardNotesApp.openapi(getNoteRoute, async (c) => {
  try {
    const id = c.req.param("id");
    const [note] = await db.select().from(notes).where(eq(notes.id, id));
    if (!note) return c.json({ error: "Note not found" }, 404);
    return c.json(note as any, 200);
  } catch (error) {
    logger.error("Failed to get note", { error });
    return c.json({ error: "Failed to get note" }, 500);
  }
});

const createNoteRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Notes"],
  summary: "Create a note",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            topic: z.string(),
            content: z.string(),
            category: z.string(),
            expiresAt: z.string().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.any() } },
      description: "Created",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardNotesApp.openapi(createNoteRoute, async (c) => {
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

    return c.json(created as any, 201);
  } catch (error) {
    logger.error("Failed to create note", { error });
    return c.json({ error: "Failed to create note" }, 500);
  }
});

const updateNoteRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Notes"],
  summary: "Update a note",
  request: {
    params: idParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            topic: z.string().optional(),
            content: z.string().optional(),
            category: z.string().optional(),
            expiresAt: z.string().nullable().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardNotesApp.openapi(updateNoteRoute, async (c) => {
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
    return c.json(updated as any, 200);
  } catch (error) {
    logger.error("Failed to update note", { error });
    return c.json({ error: "Failed to update note" }, 500);
  }
});

const deleteNoteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Notes"],
  summary: "Delete a note",
  request: {
    params: idParamSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean() }),
        },
      },
      description: "Success",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardNotesApp.openapi(deleteNoteRoute, async (c) => {
  try {
    const id = c.req.param("id");
    const [deleted] = await db
      .delete(notes)
      .where(eq(notes.id, id))
      .returning({ id: notes.id });

    if (!deleted) return c.json({ error: "Note not found" }, 404);
    return c.json({ ok: true } as any, 200);
  } catch (error) {
    logger.error("Failed to delete note", { error });
    return c.json({ error: "Failed to delete note" }, 500);
  }
});
