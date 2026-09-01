ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "suspended_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_executions" ADD COLUMN IF NOT EXISTS "suspended_until" timestamp with time zone;
