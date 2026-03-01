ALTER TABLE "emails_raw" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
CREATE INDEX "emails_raw_embedding_idx" ON "emails_raw" USING hnsw ("embedding" vector_cosine_ops);