/**
 * Backfill script: re-embed all memories and messages with text-embedding-3-large (3072 dimensions).
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... DATABASE_URL=postgresql://... npx tsx scripts/backfill-embeddings.ts
 *
 * Idempotent — only processes rows WHERE embedding IS NULL.
 * Safe to run multiple times (e.g. after a partial failure).
 */

const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMENSIONS = 3072;
const BATCH_SIZE = 50;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

interface Row {
  id: string;
  content: string;
}

interface OpenAIEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage: { prompt_tokens: number; total_tokens: number };
}

async function callOpenAIEmbeddings(
  texts: string[],
  apiKey: string,
): Promise<number[][]> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        input: texts,
      }),
    });

    if (resp.ok) {
      const body = (await resp.json()) as OpenAIEmbeddingResponse;
      body.data.sort((a, b) => a.index - b.index);
      return body.data.map((d) => d.embedding);
    }

    if (resp.status === 429) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      const retryAfter = resp.headers.get("retry-after");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay;
      console.warn(
        `Rate limited (429). Retry ${attempt + 1}/${MAX_RETRIES} after ${waitMs}ms`,
      );
      await sleep(waitMs);
      lastError = new Error(`429 Too Many Requests`);
      continue;
    }

    const errorText = await resp.text();
    throw new Error(
      `OpenAI API error ${resp.status}: ${errorText.slice(0, 500)}`,
    );
  }

  throw lastError ?? new Error("Max retries exceeded");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function vectorToSql(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

async function backfillTable(
  tableName: string,
  sql: ReturnType<Awaited<typeof import("@neondatabase/serverless")>["neon"]>,
  apiKey: string,
) {
  let totalProcessed = 0;
  let batchNumber = 0;

  console.log(`\n--- Backfilling ${tableName} ---`);

  while (true) {
    batchNumber++;

    const rows = (await sql`
      SELECT id, content FROM ${sql.unsafe(tableName)}
      WHERE embedding IS NULL
      ORDER BY id
      LIMIT ${BATCH_SIZE}
    `) as Row[];

    if (rows.length === 0) {
      console.log(`${tableName}: no more rows with NULL embeddings. Done!`);
      break;
    }

    console.log(
      `${tableName} batch ${batchNumber}: processing ${rows.length} rows...`,
    );

    const texts = rows.map((r) => r.content);
    let embeddings: number[][];

    try {
      embeddings = await callOpenAIEmbeddings(texts, apiKey);
    } catch (err) {
      console.error(`${tableName} batch ${batchNumber} failed:`, err);
      console.error(
        `Stopping ${tableName}. ${totalProcessed} rows processed so far. Re-run to continue.`,
      );
      throw err;
    }

    const ids = rows.map((r) => r.id);
    const vectors = embeddings.map((e) => vectorToSql(e));

    if (tableName === "memories") {
      await sql`
        UPDATE memories AS m
        SET embedding = data.vec::vector(3072),
            updated_at = NOW()
        FROM (
          SELECT unnest(${ids}::uuid[]) AS id,
                 unnest(${vectors}::text[]) AS vec
        ) AS data
        WHERE m.id = data.id
      `;
    } else {
      await sql`
        UPDATE messages AS m
        SET embedding = data.vec::vector(3072)
        FROM (
          SELECT unnest(${ids}::uuid[]) AS id,
                 unnest(${vectors}::text[]) AS vec
        ) AS data
        WHERE m.id = data.id
      `;
    }

    totalProcessed += rows.length;
    console.log(
      `${tableName} batch ${batchNumber} complete. Total processed: ${totalProcessed}`,
    );
  }

  return totalProcessed;
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is required");
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(databaseUrl);

  console.log("Starting embedding backfill...");
  console.log(`Model: ${EMBEDDING_MODEL} (${EMBEDDING_DIMENSIONS} dimensions)`);
  console.log(`Batch size: ${BATCH_SIZE}`);

  const memoriesCount = await backfillTable("memories", sql, apiKey);
  const messagesCount = await backfillTable("messages", sql, apiKey);

  console.log(`\nBackfill complete.`);
  console.log(`  Memories updated: ${memoriesCount}`);
  console.log(`  Messages updated: ${messagesCount}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
