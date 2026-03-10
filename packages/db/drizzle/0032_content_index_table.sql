CREATE TABLE IF NOT EXISTS "content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"excerpt" text,
	"author" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"published_at" timestamp with time zone,
	"reading_minutes" integer,
	"og_image" text,
	"embedding" vector(1536),
	"raw_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "content_slug_idx" ON "content" USING btree ("slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_type_idx" ON "content" USING btree ("type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_published_at_idx" ON "content" USING btree ("published_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_tags_idx" ON "content" USING gin ("tags");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_embedding_idx" ON "content" USING hnsw ("embedding" vector_cosine_ops);
