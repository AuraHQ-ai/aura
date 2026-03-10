-- Generated tsvector column for full-text search
ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS memories_search_vector_idx ON memories USING gin (search_vector);
--> statement-breakpoint

-- RRF scoring helper (k=60 is standard default)
CREATE OR REPLACE FUNCTION rrf_score(rank bigint, rrf_k int DEFAULT 60)
RETURNS numeric LANGUAGE SQL IMMUTABLE PARALLEL SAFE
AS $$ SELECT COALESCE(1.0 / ($1 + $2), 0.0); $$;
