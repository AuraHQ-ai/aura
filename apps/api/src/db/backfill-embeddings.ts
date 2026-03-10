/**
 * Backfill script: generates vector embeddings for all existing messages
 * and memories that don't have them yet.
 *
 * Run manually: npx tsx src/db/backfill-embeddings.ts [--messages] [--memories] [--all]
 * Safe to run multiple times (idempotent — skips already-embedded rows).
 */

import { backfillMessageEmbeddings, backfillMemoryEmbeddings, backfillNoteEmbeddings } from "../memory/store.js";

const BATCH_SIZE = parseInt(process.env.BACKFILL_BATCH_SIZE || "50", 10);
const args = process.argv.slice(2);
const doMessages = args.includes("--messages") || args.includes("--all") || args.length === 0;
const doMemories = args.includes("--memories") || args.includes("--all") || args.length === 0;
const doNotes = args.includes("--notes") || args.includes("--all") || args.length === 0;

console.log(`Backfill config: batch=${BATCH_SIZE}, messages=${doMessages}, memories=${doMemories}, notes=${doNotes}`);

try {
  if (doMessages) {
    console.log("\n--- Backfilling message embeddings ---");
    const msgCount = await backfillMessageEmbeddings(BATCH_SIZE);
    console.log(`Messages done: embedded ${msgCount} rows.`);
  }

  if (doMemories) {
    console.log("\n--- Backfilling memory embeddings ---");
    const memCount = await backfillMemoryEmbeddings(BATCH_SIZE);
    console.log(`Memories done: embedded ${memCount} rows.`);
  }

  if (doNotes) {
    console.log("\n--- Backfilling note embeddings ---");
    const noteCount = await backfillNoteEmbeddings(BATCH_SIZE);
    console.log(`Notes done: embedded ${noteCount} rows.`);
  }

  console.log("\nBackfill complete.");
} catch (error) {
  console.error("Backfill failed:", error);
  process.exit(1);
}
