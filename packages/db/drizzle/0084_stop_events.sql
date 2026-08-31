CREATE TABLE IF NOT EXISTS "stop_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"user_id" text,
	"event_ts" text,
	"streaming_message_ts" text,
	"displaced" boolean DEFAULT false NOT NULL,
	"stop_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stop_events" ADD CONSTRAINT "stop_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stop_events_channel_thread_created_idx" ON "stop_events" USING btree ("channel_id","thread_ts","created_at" DESC);
