ALTER TABLE "memories" ADD COLUMN "bench_provenance" jsonb;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bench_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"run_id" text NOT NULL,
	"dataset" text NOT NULL,
	"category" text NOT NULL,
	"score_type" text NOT NULL,
	"n" integer NOT NULL,
	"n_correct" integer NOT NULL,
	"score" real NOT NULL,
	"cost_usd" real,
	"duration_ms" integer,
	"generation_model" text,
	"judge_model" text,
	"embedding_model" text,
	"corpus_hash" text,
	"git_sha" text,
	"pr_number" integer,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bench_runs" ADD CONSTRAINT "bench_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bench_runs_run_id_idx" ON "bench_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bench_runs_dataset_category_idx" ON "bench_runs" USING btree ("dataset","category","score_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bench_runs_created_at_idx" ON "bench_runs" USING btree ("created_at");
