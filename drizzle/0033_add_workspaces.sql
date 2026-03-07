CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"bot_token" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now(),
	"is_active" boolean DEFAULT true,
	CONSTRAINT "workspaces_team_id_unique" UNIQUE("team_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_team_id_idx" ON "workspaces" USING btree ("team_id");
