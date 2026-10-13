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
  // `@ai-sdk/provider-utils` (>=5.0.51) loads `undici` via
  // `module.createRequire(getCurrentModulePath())("undici")` inside
  // `createSafeNodeFetch()`. Nitro/nft cannot see that runtime require, so
  // without an explicit trace the package is missing from the Vercel
  // function and MCP OAuth / URL downloads fail with
  // `Cannot find module 'undici'` (require stack: /var/task/index.js).
  // `undici*` full-traces the package (all files, not just statically
  // reached ones) so createRequire can resolve it next to the bundle.
  traceDeps: ["undici*"],
  vercel: {
    functions: {
      // Keep parity with the previous filesystem-functions deploy.
      maxDuration: 800,
      regions: ["fra1"],
    },
  },
});
