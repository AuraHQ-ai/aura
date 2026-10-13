/**
 * Keep `undici` in the Nitro module graph.
 *
 * `@ai-sdk/provider-utils` loads it at runtime via
 * `module.createRequire(...)("undici")` (see `createSafeNodeFetch`), which
 * file tracers cannot see. A static import plus `traceDeps: ["undici*"]`
 * in nitro.config.ts makes Nitro copy the real package into the Vercel
 * function `node_modules` so that createRequire succeeds.
 *
 * Do not remove this import without also dropping the nitro `traceDeps`
 * entry and the build-time assertion in scripts/ensure-vercel-undici.mjs.
 */
import "undici";
