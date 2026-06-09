CREATE TABLE IF NOT EXISTS "deferred_tool_thread_cache" (
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"tool_name" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deferred_tool_thread_cache_workspace_channel_thread_tool_pk" PRIMARY KEY("workspace_id","channel_id","thread_ts","tool_name")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deferred_tool_thread_cache" ADD CONSTRAINT "deferred_tool_thread_cache_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deferred_tool_thread_cache_thread_idx" ON "deferred_tool_thread_cache" USING btree ("workspace_id","channel_id","thread_ts");
