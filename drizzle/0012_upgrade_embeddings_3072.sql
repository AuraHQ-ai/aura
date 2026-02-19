-- Upgrade ALL embeddings from 1536d to 3072d

-- memories table
DROP INDEX IF EXISTS "memories_embedding_idx";
UPDATE "memories" SET "embedding" = NULL;
ALTER TABLE "memories" ALTER COLUMN "embedding" SET DATA TYPE vector(3072);
CREATE INDEX "memories_embedding_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);

-- messages table
DROP INDEX IF EXISTS "messages_embedding_idx";
UPDATE "messages" SET "embedding" = NULL;
ALTER TABLE "messages" ALTER COLUMN "embedding" SET DATA TYPE vector(3072);
CREATE INDEX "messages_embedding_idx" ON "messages" USING hnsw ("embedding" vector_cosine_ops);

-- Clear persisted embedding model setting
DELETE FROM "settings" WHERE "key" = 'model_embedding';
