ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "bench_provenance" jsonb;--> statement-breakpoint
ALTER TABLE "bench_runs" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
