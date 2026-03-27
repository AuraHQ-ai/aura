-- Drop governance tables (CASCADE handles FKs like approvals → approval_policies)
DROP TABLE IF EXISTS "approvals" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "tool_credential_slots" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "tool_definitions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "approval_policies" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "rate_limits" CASCADE;--> statement-breakpoint

-- Remove approval columns from jobs
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "approval_status";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "pending_action_log_id";--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_approval_status_check";--> statement-breakpoint

-- Remove approval/risk columns from action_log
ALTER TABLE "action_log" DROP COLUMN IF EXISTS "risk_tier";--> statement-breakpoint
ALTER TABLE "action_log" DROP COLUMN IF EXISTS "approved_by";--> statement-breakpoint
ALTER TABLE "action_log" DROP COLUMN IF EXISTS "approved_at";--> statement-breakpoint

-- Update action_log status check to only allow executed/failed
ALTER TABLE "action_log" DROP CONSTRAINT IF EXISTS "action_log_risk_tier_check";--> statement-breakpoint
ALTER TABLE "action_log" DROP CONSTRAINT IF EXISTS "action_log_status_check";--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_status_check" CHECK ("status" IN ('executed','failed'));
