CREATE TABLE "dashboard_chat_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"thread_id" text NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text,
	"message_id" text NOT NULL,
	"prompt" text NOT NULL,
	"model_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "dashboard_chat_runs_status_check" CHECK ("dashboard_chat_runs"."status" IN ('generating', 'completed', 'failed', 'cancelled'))
);--> statement-breakpoint
ALTER TABLE "dashboard_chat_runs" ADD CONSTRAINT "dashboard_chat_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_chat_runs_thread_status_idx" ON "dashboard_chat_runs" USING btree ("workspace_id","thread_id","status");--> statement-breakpoint
CREATE INDEX "dashboard_chat_runs_updated_idx" ON "dashboard_chat_runs" USING btree ("updated_at");--> statement-breakpoint
CREATE TABLE "dashboard_chat_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"run_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"chunk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "dashboard_chat_chunks" ADD CONSTRAINT "dashboard_chat_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_chat_chunks" ADD CONSTRAINT "dashboard_chat_chunks_run_id_dashboard_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."dashboard_chat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_chat_chunks_workspace_run_idx" ON "dashboard_chat_chunks" USING btree ("workspace_id","run_id","chunk_index");--> statement-breakpoint
CREATE INDEX "dashboard_chat_chunks_run_idx" ON "dashboard_chat_chunks" USING btree ("run_id","chunk_index");
