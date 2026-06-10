CREATE TABLE IF NOT EXISTS "dashboard_chat_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_message" text,
	"status" text DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "dashboard_chat_runs_status_check" CHECK ("status" IN ('running', 'completed', 'failed', 'cancelled'))
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dashboard_chat_runs" ADD CONSTRAINT "dashboard_chat_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dashboard_chat_runs_workspace_run_idx" ON "dashboard_chat_runs" USING btree ("workspace_id","run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dashboard_chat_runs_thread_idx" ON "dashboard_chat_runs" USING btree ("workspace_id","thread_id","created_at");
