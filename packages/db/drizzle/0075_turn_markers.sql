CREATE TABLE IF NOT EXISTS "turn_markers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"invocation_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text,
	"message_ts" text,
	"user_id" text,
	"status" text DEFAULT 'started' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "turn_markers_status_check" CHECK ("status" IN ('started', 'completed', 'failed', 'recovered'))
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "turn_markers" ADD CONSTRAINT "turn_markers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "turn_markers_workspace_invocation_idx" ON "turn_markers" USING btree ("workspace_id","invocation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "turn_markers_status_started_at_idx" ON "turn_markers" USING btree ("status","started_at");
