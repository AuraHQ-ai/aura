-- Upgrade embedding dimensions from 1536 (text-embedding-3-small) to 3072 (text-embedding-3-large)
-- Existing embeddings must be re-generated via backfill script after deploy.

-- 1. Drop the HNSW index (can't alter column type with index present)
DROP INDEX IF EXISTS "memories_embedding_idx";

-- 2. Null out existing embeddings (incompatible dimensions — backfill will re-embed)
UPDATE "memories" SET "embedding" = NULL;

-- 3. Alter column to new dimensions
ALTER TABLE "memories" ALTER COLUMN "embedding" SET DATA TYPE vector(3072);

-- 4. Recreate HNSW index for 3072-dim vectors
CREATE INDEX "memories_embedding_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);
