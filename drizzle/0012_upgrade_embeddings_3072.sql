-- Upgrade ALL embeddings from 1536d to 3072d

-- memories table
DROP INDEX IF EXISTS "memories_embedding_idx";--> statement-breakpoint
UPDATE "memories" SET "embedding" = NULL;--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "embedding" SET DATA TYPE vector(3072);--> statement-breakpoint
CREATE INDEX "memories_embedding_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint

-- messages table
DROP INDEX IF EXISTS "messages_embedding_idx";--> statement-breakpoint
UPDATE "messages" SET "embedding" = NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "embedding" SET DATA TYPE vector(3072);--> statement-breakpoint
CREATE INDEX "messages_embedding_idx" ON "messages" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint

-- Clear persisted embedding model setting
DELETE FROM "settings" WHERE "key" = 'model_embedding';
