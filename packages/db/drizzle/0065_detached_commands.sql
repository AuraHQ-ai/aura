CREATE TABLE IF NOT EXISTS "detached_commands" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL DEFAULT 'default' REFERENCES "workspaces"("id"),
  "pid" integer,
  "command" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "exit_code" integer,
  "requested_by" text NOT NULL,
  "channel_id" text,
  "thread_ts" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "stdout_tail" text,
  "stderr_tail" text,
  CONSTRAINT "detached_commands_status_check" CHECK ("status" IN ('running', 'completed', 'failed', 'killed'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "detached_commands_status_started_at_idx" ON "detached_commands" ("status", "started_at");
