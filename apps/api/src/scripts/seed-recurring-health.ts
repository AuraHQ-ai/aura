import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
const envFile = isProd ? ".env.production" : ".env.local";

config({ path: resolve(repoRoot, envFile) });
if (isProd) console.log("Using .env.production (--prod)");

const {
  RECURRING_JOB_HEALTH_MONITOR_NAME,
  getRecurringJobHealthMonitorSeed,
  seedRecurringJobHealthMonitor,
} = await import("../jobs/seeds/index.js");

try {
  const seed = getRecurringJobHealthMonitorSeed();
  await seedRecurringJobHealthMonitor();
  console.log(
    `Seeded recurring job "${RECURRING_JOB_HEALTH_MONITOR_NAME}" (${seed.cronSchedule} ${seed.timezone}) for ${seed.requestedBy}.`,
  );
} catch (error) {
  console.error("Failed to seed recurring job health monitor:", error);
  process.exit(1);
}
