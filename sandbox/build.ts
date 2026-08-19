/**
 * Build the Aura E2B sandbox template.
 *
 * Usage:
 *   pnpm --filter aura-sandbox build          # dev
 *   pnpm --filter aura-sandbox build:prod     # production
 *
 * Reads e2b.Dockerfile as the single source of truth via fromDockerfile().
 * Requires E2B_API_KEY in .env.local or environment.
 */
import { config } from "dotenv";
import { readFileSync } from "fs";
import { resolve } from "path";

config({ path: resolve(__dirname, "..", ".env.local") });

import { Template, defaultBuildLogger } from "e2b";

const isProd = process.argv.includes("--prod");
const tag = isProd ? "aura-sandbox" : "aura-sandbox-dev";

const dockerfile = readFileSync(resolve(__dirname, "e2b.Dockerfile"), "utf-8");
const template = Template().fromDockerfile(dockerfile);

async function main() {
  console.log(`Building e2b template: ${tag} (${isProd ? "prod" : "dev"})`);
  console.log("This will take 5-10 minutes...\n");

  const result = await Template.build(template, tag, {
    cpuCount: 4,
    memoryMB: 4096,
    onBuildLogs: defaultBuildLogger(),
  });

  console.log(`\nBuild complete!`);
  console.log(`Template ID: ${result.templateId}`);
  console.log(`Tag: ${tag}`);
  console.log(`\nSet in Vercel:\n  E2B_TEMPLATE_ID=${result.templateId}`);
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
