CREATE TABLE IF NOT EXISTS "app_context_cache" (
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"user_id" text NOT NULL,
	"entities" jsonb NOT NULL,
	"event_ts" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_context_cache_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_context_cache" ADD CONSTRAINT "app_context_cache_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
