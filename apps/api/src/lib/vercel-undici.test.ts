import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

type EnsureHelpers = {
  listFuncDirs: (functionsRoot: string) => string[];
  functionHasUndici: (funcDir: string) => boolean;
  functionCanResolveUndici: (funcDir: string) => boolean;
  ensureUndiciInVercelOutput: (opts: {
    functionsRoot: string;
    apiRoot: string;
    copyIfMissing?: boolean;
  }) => Array<{
    funcDir: string;
    present: boolean;
    copied: boolean;
    resolvable: boolean;
  }>;
};

let helpers: EnsureHelpers;

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aura-undici-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("undici Vercel deploy contract", () => {
  it("declares undici as a direct apps/api dependency", () => {
    const pkg = JSON.parse(readFileSync(join(apiRoot, "package.json"), "utf8"));
    expect(pkg.dependencies.undici).toMatch(/^\^?7\./);
  });

  it("asks Nitro to full-trace undici into the server output", () => {
    const config = readFileSync(join(apiRoot, "nitro.config.ts"), "utf8");
    expect(config).toMatch(/traceDeps:\s*\[[^\]]*undici\*/);
  });

  it("keeps a static undici import in the Nitro entry graph", () => {
    const entry = readFileSync(join(apiRoot, "src/nitro-app.ts"), "utf8");
    const pin = readFileSync(join(apiRoot, "src/ensure-undici.ts"), "utf8");
    expect(entry).toContain('import "./ensure-undici.js"');
    expect(pin).toMatch(/import ["']undici["']/);
  });
});

describe("ensureUndiciInVercelOutput", () => {
  beforeAll(async () => {
    const scriptPath = join(apiRoot, "scripts/ensure-vercel-undici.mjs");
    helpers = (await import(scriptPath)) as EnsureHelpers;
  });

  it("lists nested *.func directories", () => {
    const root = tempDir();
    mkdirSync(join(root, "nested", "workflow.func"), { recursive: true });
    mkdirSync(join(root, "__server.func"), { recursive: true });
    const dirs = helpers.listFuncDirs(root).sort();
    expect(dirs).toEqual([join(root, "__server.func"), join(root, "nested", "workflow.func")]);
  });

  it("copies undici into functions that Nitro missed and then resolves it", () => {
    const functionsRoot = tempDir();
    const funcDir = join(functionsRoot, "__server.func");
    mkdirSync(funcDir, { recursive: true });
    writeFileSync(join(funcDir, "index.js"), "export default {};\n");

    expect(helpers.functionHasUndici(funcDir)).toBe(false);

    const results = helpers.ensureUndiciInVercelOutput({
      functionsRoot,
      apiRoot,
    });

    expect(results).toHaveLength(1);
    expect(results[0].copied).toBe(true);
    expect(results[0].present).toBe(true);
    expect(results[0].resolvable).toBe(true);
    expect(helpers.functionHasUndici(funcDir)).toBe(true);
    expect(helpers.functionCanResolveUndici(funcDir)).toBe(true);
  });

  it("fails the build when no functions were emitted", () => {
    expect(() =>
      helpers.ensureUndiciInVercelOutput({
        functionsRoot: tempDir(),
        apiRoot,
        copyIfMissing: false,
      }),
    ).toThrow(/No Vercel function dirs/);
  });
});
