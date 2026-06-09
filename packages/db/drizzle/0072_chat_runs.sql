DO $$ BEGIN
 CREATE TYPE "public"."chat_run_status" AS ENUM('running', 'done', 'error', 'canceled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"thread_id" text NOT NULL,
	"user_id" text,
	"model_id" text,
	"status" "chat_run_status" DEFAULT 'running' NOT NULL,
	"input_messages" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_run_chunks" (
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"chunk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_run_chunks_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_run_chunks" ADD CONSTRAINT "chat_run_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_run_chunks" ADD CONSTRAINT "chat_run_chunks_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_runs_thread" ON "chat_runs" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_runs_status" ON "chat_runs" USING btree ("status");
