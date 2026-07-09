import { defineNitroConfig } from "nitro/config";

/**
 * Nitro build config — exists so the Workflow DevKit ("use workflow" /
 * "use step" directives) can be compiled and served alongside the Hono app.
 *
 * - All HTTP traffic is routed to the existing Hono app (src/app.ts).
 * - The `workflow/nitro` module compiles `workflows/**` and registers the
 *   `/.well-known/workflow/v1/*` handler routes (flow, step, webhook).
 * - On Vercel (preset `vercel`), the workflow handlers are emitted as
 *   dedicated queue-triggered functions (Build Output API).
 */
export default defineNitroConfig({
  modules: ["workflow/nitro"],
  compatibilityDate: "2026-06-09",
  routes: {
    "/**": "./src/nitro-app.ts",
  },
  vercel: {
    functions: {
      // Keep parity with the previous filesystem-functions deploy.
      maxDuration: 800,
      regions: ["fra1"],
    },
  },
});
