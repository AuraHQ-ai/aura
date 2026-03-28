CREATE TYPE extraction_source_role AS ENUM ('user', 'assistant', 'tool');--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "extraction_source_role" extraction_source_role;
