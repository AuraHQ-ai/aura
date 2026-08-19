DO $$ BEGIN
  CREATE TYPE extraction_source_role AS ENUM ('user', 'assistant', 'tool');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "extraction_source_role" extraction_source_role;
