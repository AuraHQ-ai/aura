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
--> statement-breakpoint

-- Create HITL pending_approvals table (DB-backed for cross-request persistence)
CREATE TABLE IF NOT EXISTS "pending_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tool_name" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "args" jsonb NOT NULL,
  "channel_id" text NOT NULL,
  "thread_ts" text,
  "user_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "resolved_by" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_approvals_status_idx" ON "pending_approvals" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_approvals_created_at_idx" ON "pending_approvals" USING btree ("created_at");
