ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "model" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "env_allowlist" text[];--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "prompt_mode" text;
