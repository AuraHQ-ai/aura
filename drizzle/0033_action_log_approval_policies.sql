-- action_log: append-only audit trail for every tool invocation
CREATE TABLE IF NOT EXISTS "action_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tool_name" text NOT NULL,
  "params" jsonb NOT NULL,
  "trigger_type" text NOT NULL,
  "triggered_by" text NOT NULL,
  "job_id" uuid REFERENCES "jobs"("id"),
  "credential_name" text,
  "risk_tier" text NOT NULL,
  "status" text NOT NULL,
  "result" jsonb,
  "approved_by" text,
  "approved_at" timestamp with time zone,
  "idempotency_key" text UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "action_log_trigger_type_check" CHECK ("trigger_type" IN ('user_message', 'scheduled_job', 'autonomous')),
  CONSTRAINT "action_log_risk_tier_check" CHECK ("risk_tier" IN ('read', 'write', 'destructive')),
  CONSTRAINT "action_log_status_check" CHECK ("status" IN ('executed', 'pending_approval', 'approved', 'rejected', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_log_tool_name_idx" ON "action_log" USING btree ("tool_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_log_triggered_by_idx" ON "action_log" USING btree ("triggered_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_log_status_idx" ON "action_log" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_log_created_at_idx" ON "action_log" USING btree ("created_at");
--> statement-breakpoint

-- approval_policies: admin-managed rules for tool governance
CREATE TABLE IF NOT EXISTS "approval_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tool_pattern" text,
  "url_pattern" text,
  "http_methods" text[],
  "credential_name" text,
  "risk_tier" text NOT NULL,
  "approver_ids" text[],
  "approval_channel" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "approval_policies_risk_tier_check" CHECK ("risk_tier" IN ('read', 'write', 'destructive'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_policies_tool_pattern_idx" ON "approval_policies" USING btree ("tool_pattern");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_policies_url_pattern_idx" ON "approval_policies" USING btree ("url_pattern");
--> statement-breakpoint

-- Add governance columns to jobs table
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "approval_status" text;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "pending_action_log_id" uuid;
--> statement-breakpoint

-- Immutability trigger: block updates to identity fields on action_log
CREATE OR REPLACE FUNCTION action_log_immutable_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.tool_name IS DISTINCT FROM NEW.tool_name THEN
    RAISE EXCEPTION 'Cannot modify action_log.tool_name after insert';
  END IF;
  IF OLD.params IS DISTINCT FROM NEW.params THEN
    RAISE EXCEPTION 'Cannot modify action_log.params after insert';
  END IF;
  IF OLD.triggered_by IS DISTINCT FROM NEW.triggered_by THEN
    RAISE EXCEPTION 'Cannot modify action_log.triggered_by after insert';
  END IF;
  IF OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Cannot modify action_log.created_at after insert';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER action_log_immutable_trigger
  BEFORE UPDATE ON "action_log"
  FOR EACH ROW
  EXECUTE FUNCTION action_log_immutable_guard();
