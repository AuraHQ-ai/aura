ALTER TABLE "messages" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
CREATE INDEX "messages_embedding_idx" ON "messages" USING hnsw ("embedding" vector_cosine_ops);