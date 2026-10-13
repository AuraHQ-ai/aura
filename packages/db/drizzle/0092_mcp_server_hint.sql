ALTER TABLE "mcp_servers" ADD COLUMN "hint" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "cached_instructions" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "instructions_cached_at" timestamp with time zone;
