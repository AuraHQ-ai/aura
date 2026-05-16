import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";
import {
  getSkillNotesForBackfill,
  upsertSkillEmbeddingForNote,
} from "../skills/retrieve.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
const envFile = isProd ? ".env.production" : ".env.local";
config({ path: resolve(repoRoot, envFile) });
if (isProd) console.log("Using .env.production (--prod)");

const BATCH_SIZE = 50;

async function main(): Promise<void> {
  console.log("Backfilling skill embeddings...");

  let offset = 0;
  let processed = 0;

  while (true) {
    const batch = await getSkillNotesForBackfill(BATCH_SIZE, offset);
    if (batch.length === 0) break;

    for (const note of batch) {
      await upsertSkillEmbeddingForNote({
        noteId: note.id,
        summary: note.summary,
        content: note.content,
      });
      processed += 1;
    }

    console.log(`Processed ${processed} skills...`);
    offset += batch.length;
  }

  console.log(`Skill embedding backfill complete. Total processed: ${processed}`);
}

main().catch((error) => {
  logger.error("Skill embedding backfill failed", {
    error: String(error),
  });
  process.exit(1);
});
