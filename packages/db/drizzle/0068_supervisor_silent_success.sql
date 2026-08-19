ALTER TABLE "jobs" ADD COLUMN "notify_on_success" boolean NOT NULL DEFAULT false;--> statement-breakpoint
UPDATE "jobs" SET "notify_on_success" = true WHERE "cron_schedule" IS NULL;--> statement-breakpoint
ALTER TABLE "job_outcomes" DROP CONSTRAINT IF EXISTS "job_outcomes_supervisor_decision_check";--> statement-breakpoint
ALTER TABLE "job_outcomes" ADD CONSTRAINT "job_outcomes_supervisor_decision_check" CHECK ("supervisor_decision" IS NULL OR "supervisor_decision" IN ('retry_as_is', 'retry_with_fix', 'silent_success', 'report_success', 'report_failure', 'escalate', 'disable_job'));--> statement-breakpoint
