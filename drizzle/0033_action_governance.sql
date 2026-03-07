-- Action governance infrastructure: action_log + approval_policies tables

DO $$ BEGIN
  CREATE TYPE "public"."action_status" AS ENUM('executed', 'pending_approval', 'approved', 'rejected', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."risk_tier" AS ENUM('read', 'write', 'destructive');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "action_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tool_name" text NOT NULL,
  "params" jsonb,
  "result" jsonb,
  "status" "action_status" NOT NULL,
  "risk_tier" "risk_tier" NOT NULL,
  "trigger_type" text NOT NULL DEFAULT 'interactive',
  "triggered_by" text NOT NULL,
  "credential_id" uuid REFERENCES "credentials"("id") ON DELETE SET NULL,
  "approval_message_ts" text,
  "approval_channel" text,
  "approved_by" text,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "approval_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tool_pattern" text NOT NULL,
  "risk_tier_override" "risk_tier",
  "approver_ids" text[] NOT NULL DEFAULT '{}'::text[],
  "approval_channel" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "action_log_tool_name_idx" ON "action_log" USING btree ("tool_name");
CREATE INDEX IF NOT EXISTS "action_log_status_idx" ON "action_log" USING btree ("status");
CREATE INDEX IF NOT EXISTS "action_log_triggered_by_idx" ON "action_log" USING btree ("triggered_by");
CREATE INDEX IF NOT EXISTS "action_log_created_at_idx" ON "action_log" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "action_log_credential_id_idx" ON "action_log" USING btree ("credential_id");
CREATE UNIQUE INDEX IF NOT EXISTS "approval_policies_tool_pattern_idx" ON "approval_policies" USING btree ("tool_pattern");
