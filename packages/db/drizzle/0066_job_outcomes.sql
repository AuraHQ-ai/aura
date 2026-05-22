-- Raw worker outcomes for the supervisor pattern.
-- PR 1 stores outcomes only; supervisor_* columns are populated by follow-up PRs.
CREATE TABLE IF NOT EXISTS "job_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" text NOT NULL DEFAULT 'default' REFERENCES "workspaces"("id"),
  "job_id" uuid NOT NULL REFERENCES "jobs"("id"),
  "job_execution_id" uuid REFERENCES "job_executions"("id"),
  "outcome_status" text NOT NULL,
  "output" jsonb,
  "error" text,
  "last_n_steps" jsonb,
  "supervisor_status" text NOT NULL DEFAULT 'pending_review',
  "supervisor_invocation_id" text,
  "supervisor_started_at" timestamp with time zone,
  "supervisor_decision" text,
  "supervisor_reasoning" text,
  "supervisor_attempts" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_outcomes_outcome_status_check" CHECK ("outcome_status" IN ('succeeded', 'errored', 'interrupted')),
  CONSTRAINT "job_outcomes_supervisor_status_check" CHECK ("supervisor_status" IN ('pending_review', 'in_progress', 'resolved', 'skipped')),
  CONSTRAINT "job_outcomes_supervisor_decision_check" CHECK ("supervisor_decision" IS NULL OR "supervisor_decision" IN ('retry_as_is', 'retry_with_fix', 'report_success', 'report_failure', 'escalate', 'disable_job'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_outcomes_job_created_idx" ON "job_outcomes" ("job_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_outcomes_supervisor_status_started_idx" ON "job_outcomes" ("supervisor_status", "supervisor_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_outcomes_job_execution_id_idx" ON "job_outcomes" ("job_execution_id") WHERE job_execution_id IS NOT NULL;--> statement-breakpoint
