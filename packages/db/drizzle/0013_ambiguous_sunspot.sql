ALTER TABLE "notes" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
CREATE INDEX "notes_embedding_idx" ON "notes" USING hnsw ("embedding" vector_cosine_ops);