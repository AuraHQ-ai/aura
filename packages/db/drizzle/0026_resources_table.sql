CREATE TABLE IF NOT EXISTS "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"parent_url" text,
	"title" text,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"content" text,
	"summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedding" vector(1536),
	"content_hash" text,
	"error_message" text,
	"crawled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_status_check" CHECK ("resources"."status" IN ('pending', 'ready', 'error'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "resources_url_idx" ON "resources" USING btree ("url");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resources_embedding_idx" ON "resources" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resources_content_fts_idx" ON "resources" USING gin (to_tsvector('english', coalesce("content", '')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resources_source_idx" ON "resources" USING btree ("source");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resources_parent_url_idx" ON "resources" USING btree ("parent_url") WHERE "parent_url" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resources_crawled_at_idx" ON "resources" USING btree ("crawled_at");
