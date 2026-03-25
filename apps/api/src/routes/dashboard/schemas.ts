import { z } from "@hono/zod-openapi";

export const errorSchema = z.object({
  error: z.string(),
});

export const okSchema = z.object({
  ok: z.boolean(),
});

export const paginationQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
});

export const idParamSchema = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});
