/**
 * Guarantee `undici` is resolvable from every Vercel function Nitro emits.
 *
 * `@ai-sdk/provider-utils` `createSafeNodeFetch()` does
 * `module.createRequire(getCurrentModulePath())("undici")`. When
 * provider-utils is bundled into `/var/task/index.js`, that require looks
 * for `./node_modules/undici` next to the function entry. Nitro/nft cannot
 * see the runtime createRequire, so we:
 *   1. Prefer the copy Nitro already made via `traceDeps: ["undici*"]`.
 *   2. If a function is still missing it, copy from the apps/api install.
 *   3. Fail the build if any function still cannot resolve `undici`.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const UNDICI_PACKAGE = "undici";

export function listFuncDirs(functionsRoot) {
  if (!existsSync(functionsRoot)) return [];
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!statSync(full).isDirectory()) continue;
      if (name.endsWith(".func")) found.push(full);
      else walk(full);
    }
  };
  walk(functionsRoot);
  return found;
}

export function functionHasUndici(funcDir) {
  return existsSync(join(funcDir, "node_modules", UNDICI_PACKAGE, "package.json"));
}

export function resolveUndiciSource(fromDir) {
  const require = createRequire(join(fromDir, "package.json"));
  return dirname(require.resolve(`${UNDICI_PACKAGE}/package.json`));
}

export function copyUndiciInto(funcDir, source) {
  const dest = join(funcDir, "node_modules", UNDICI_PACKAGE);
  mkdirSync(join(funcDir, "node_modules"), { recursive: true });
  cpSync(source, dest, { recursive: true });
}

/**
 * createRequire from the function entry — the same lookup
 * `createSafeNodeFetch()` performs after provider-utils is inlined.
 */
export function functionCanResolveUndici(funcDir) {
  const entries = ["index.js", "index.mjs", ".nitro/index.mjs"];
  for (const entry of entries) {
    const entryPath = join(funcDir, entry);
    if (!existsSync(entryPath)) continue;
    try {
      createRequire(entryPath).resolve(UNDICI_PACKAGE);
      return true;
    } catch {
      // try the next candidate
    }
  }
  // Fallback: resolve from the function directory itself (Vercel sets
  // /var/task as the module root even when the entry name differs).
  try {
    createRequire(join(funcDir, "package.json")).resolve(UNDICI_PACKAGE);
    return true;
  } catch {
    return functionHasUndici(funcDir);
  }
}

export function ensureUndiciInVercelOutput({ functionsRoot, apiRoot, copyIfMissing = true }) {
  const funcs = listFuncDirs(functionsRoot);
  if (funcs.length === 0) {
    throw new Error(`No Vercel function dirs (*.func) found under ${functionsRoot}`);
  }

  const source = resolveUndiciSource(apiRoot);
  const results = [];

  for (const funcDir of funcs) {
    let present = functionHasUndici(funcDir);
    let copied = false;
    if (!present && copyIfMissing) {
      copyUndiciInto(funcDir, source);
      copied = true;
      present = functionHasUndici(funcDir);
    }
    const resolvable = present && functionCanResolveUndici(funcDir);
    results.push({ funcDir, present, copied, resolvable });
  }

  const missing = results.filter((r) => !r.resolvable);
  if (missing.length > 0) {
    throw new Error(
      `undici is not resolvable from Vercel functions:\n${missing
        .map((m) => `  - ${m.funcDir}`)
        .join("\n")}`,
    );
  }

  return results;
}
