-- Drop the old governance system tables and columns.
-- Audit trail now lives in Slack messages; HITL uses SDK-native needsApproval.

-- Remove immutability trigger + function first (depends on action_log)
DROP TRIGGER IF EXISTS action_log_immutable_trigger ON "action_log";
--> statement-breakpoint
DROP FUNCTION IF EXISTS action_log_immutable_guard();
--> statement-breakpoint

-- Drop governance columns from jobs
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "approval_status";
--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "pending_action_log_id";
--> statement-breakpoint

-- Drop tables
DROP TABLE IF EXISTS "approval_policies";
--> statement-breakpoint
DROP TABLE IF EXISTS "action_log";
