CREATE TABLE IF NOT EXISTS "github_pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"repo" text NOT NULL,
	"number" integer NOT NULL,
	"title" text,
	"url" text,
	"author" text,
	"state" text DEFAULT 'open' NOT NULL,
	"linked_issues" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"opened_at" timestamp with time zone,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_prs_workspace_repo_number_idx" ON "github_pull_requests" ("workspace_id","repo","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_prs_state_idx" ON "github_pull_requests" ("state");
