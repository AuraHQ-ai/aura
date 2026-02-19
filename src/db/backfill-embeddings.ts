/**
 * Backfill script: generates vector embeddings for all existing messages
 * that don't have them yet.
 *
 * Run manually: npx tsx src/db/backfill-embeddings.ts
 * Safe to run multiple times (idempotent — skips already-embedded messages).
 */

import { backfillMessageEmbeddings } from "../memory/store.js";

const BATCH_SIZE = parseInt(process.env.BACKFILL_BATCH_SIZE || "50", 10);

console.log(`Starting message embedding backfill (batch size: ${BATCH_SIZE})...`);

try {
  const count = await backfillMessageEmbeddings(BATCH_SIZE);
  console.log(`Done. Embedded ${count} messages.`);
} catch (error) {
  console.error("Backfill failed:", error);
  process.exit(1);
}
