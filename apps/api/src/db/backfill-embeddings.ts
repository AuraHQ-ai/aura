/**
 * Backfill script: generates vector embeddings for all existing messages
 * and memories that don't have them yet.
 *
 * Run manually: npx tsx src/db/backfill-embeddings.ts [--messages] [--memories] [--all]
 * Safe to run multiple times (idempotent — skips already-embedded rows).
 */

import { backfillMessageEmbeddings, backfillMemoryEmbeddings, backfillNoteEmbeddings } from "../memory/store.js";
import { createProgress, type ProgressTracker } from "../lib/progress.js";

const BATCH_SIZE = parseInt(process.env.BACKFILL_BATCH_SIZE || "50", 10);
const args = process.argv.slice(2);
const doMessages = args.includes("--messages") || args.includes("--all") || args.length === 0;
const doMemories = args.includes("--memories") || args.includes("--all") || args.length === 0;
const doNotes = args.includes("--notes") || args.includes("--all") || args.length === 0;

console.log(`Backfill config: batch=${BATCH_SIZE}, messages=${doMessages}, memories=${doMemories}, notes=${doNotes}`);

function makeProgressCb(label: string): { cb: (completed: number, total: number) => void; getTracker: () => ProgressTracker | null } {
  let tracker: ProgressTracker | null = null;
  let lastCompleted = 0;
  return {
    cb: (completed, total) => {
      if (!tracker) tracker = createProgress(total, { label, logEvery: BATCH_SIZE });
      const delta = completed - lastCompleted;
      if (delta > 0) tracker.tick(delta);
      lastCompleted = completed;
    },
    getTracker: () => tracker,
  };
}

try {
  if (doMessages) {
    console.log("\n--- Backfilling message embeddings ---");
    const p = makeProgressCb("messages");
    const msgCount = await backfillMessageEmbeddings(BATCH_SIZE, p.cb);
    p.getTracker()?.done();
    console.log(`Messages done: embedded ${msgCount} rows.`);
  }

  if (doMemories) {
    console.log("\n--- Backfilling memory embeddings ---");
    const p = makeProgressCb("memories");
    const memCount = await backfillMemoryEmbeddings(BATCH_SIZE, p.cb);
    p.getTracker()?.done();
    console.log(`Memories done: embedded ${memCount} rows.`);
  }

  if (doNotes) {
    console.log("\n--- Backfilling note embeddings ---");
    const p = makeProgressCb("notes");
    const noteCount = await backfillNoteEmbeddings(BATCH_SIZE, p.cb);
    p.getTracker()?.done();
    console.log(`Notes done: embedded ${noteCount} rows.`);
  }

  console.log("\nBackfill complete.");
} catch (error) {
  console.error("Backfill failed:", error);
  process.exit(1);
}
