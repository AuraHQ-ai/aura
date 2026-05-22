ALTER TABLE "job_outcomes" DROP CONSTRAINT IF EXISTS "job_outcomes_outcome_status_check";--> statement-breakpoint
ALTER TABLE "job_outcomes" ADD CONSTRAINT "job_outcomes_outcome_status_check" CHECK ("outcome_status" IN ('succeeded', 'errored', 'interrupted', 'process_died_pre_execution'));--> statement-breakpoint
