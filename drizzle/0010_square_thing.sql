-- Upgrade embeddings from text-embedding-3-small (1536d) to text-embedding-3-large (3072d)
-- Existing 1536-d vectors are incompatible, so we NULL them and re-embed via backfill script.

-- 1. Drop the HNSW index (cannot alter column type while index references it)
DROP INDEX IF EXISTS "memories_embedding_idx";

-- 2. Clear existing embeddings (1536-d vectors can't be cast to 3072-d)
UPDATE "memories" SET "embedding" = NULL;

-- 3. Widen the column to 3072 dimensions
ALTER TABLE "memories" ALTER COLUMN "embedding" SET DATA TYPE vector(3072);

-- 4. Recreate the HNSW index for cosine similarity search
CREATE INDEX "memories_embedding_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);

-- 5. Clear any persisted embedding model override so getEmbeddingModel() falls
--    back to the new default (text-embedding-3-large, 3072-d).
DELETE FROM "settings" WHERE "key" = 'model_embedding';
