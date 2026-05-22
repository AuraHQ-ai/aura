-- Raw worker outcomes for the supervisor pattern.
-- PR 1 stores outcomes only; supervisor_* columns are populated by follow-up PRs.
CREATE TABLE IF NOT EXISTS "job_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" text NOT NULL DEFAULT 'default' REFERENCES "workspaces"("id"),
  "job_id" uuid NOT NULL REFERENCES "jobs"("id"),
  "execution_id" uuid REFERENCES "job_executions"("id"),
  "status" text NOT NULL,
  "output" jsonb,
  "error" jsonb,
  "tool_trace" jsonb,
  "supervisor_decision" text,
  "supervisor_reasoning" text,
  "supervisor_dm_ts" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "supervised_at" timestamp with time zone,
  CONSTRAINT "job_outcomes_status_check" CHECK ("status" IN ('completed', 'errored', 'process_died', 'script_failed'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_outcomes_job_created_idx" ON "job_outcomes" ("job_id", "created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_outcomes_execution_id_idx" ON "job_outcomes" ("execution_id") WHERE execution_id IS NOT NULL;--> statement-breakpoint
