import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Env } from "hono";
import type { Hook } from "@hono/zod-openapi";

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

const validationHook: Hook<any, Env, any, any> = (result, c) => {
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation error";
    return c.json({ error: message }, 400);
  }
};

export function createDashboardApp() {
  return new OpenAPIHono({ defaultHook: validationHook });
}
