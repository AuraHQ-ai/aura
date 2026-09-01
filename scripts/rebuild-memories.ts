/**
 * Repo-root entry point for the memory rebuild/replay tool (#1041).
 *
 * The implementation lives in `apps/api/src/scripts/rebuild-memories.ts`
 * (it needs the API app's dependencies and memory pipeline). This wrapper
 * keeps the documented `scripts/rebuild-memories.ts` path working:
 *
 *   pnpm rebuild:memories -- --user=U0123ABC            # from the repo root
 *   pnpm --filter aura-api exec tsx ../../scripts/rebuild-memories.ts --user=U0123ABC
 *
 * A scope (--user / --channel / --since / --until) is always required and
 * dry-run is the default. See the implementation header for all flags.
 *
 * NOTE: the repo root is CJS (no "type": "module"), so this wrapper uses a
 * dynamic import — the target is an ESM module with top-level await.
 */
import("../apps/api/src/scripts/rebuild-memories.js").catch((err) => {
  console.error("rebuild-memories failed:", err);
  process.exit(1);
});
