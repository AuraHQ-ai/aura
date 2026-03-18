-- Phase 1: Add workspace_id to all tables for multi-tenant isolation.

-- 1. Create workspaces table
CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text,
  "domain" text,
  "installed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "plan" text DEFAULT 'free',
  "settings" jsonb
);--> statement-breakpoint

-- 2. Seed default workspace (must exist before FK constraints)
INSERT INTO "workspaces" ("id", "name") VALUES ('default', 'Default') ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 3. Add nullable workspace_id columns to all 25 tables
ALTER TABLE "messages" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "job_executions" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "credential_grants" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "credential_audit_log" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "emails_raw" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "event_locks" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "error_events" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "conversation_traces" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "conversation_parts" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "conversation_locks" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "action_log" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD COLUMN "workspace_id" text;--> statement-breakpoint

-- 4. Backfill all existing rows with 'default'
UPDATE "messages" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "memories" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "notes" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "people" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "addresses" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "user_profiles" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "channels" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "settings" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "jobs" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "job_executions" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "credentials" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "credential_grants" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "credential_audit_log" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "oauth_tokens" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "emails_raw" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "event_locks" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "feedback" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "error_events" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "model_pricing" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "conversation_traces" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "conversation_messages" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "conversation_parts" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "conversation_locks" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "action_log" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "approval_policies" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint

-- 5. Set NOT NULL and DEFAULT on all workspace_id columns
ALTER TABLE "messages" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "people" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "addresses" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "addresses" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "user_profiles" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "settings" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "job_executions" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "job_executions" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "credential_grants" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_grants" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "credential_audit_log" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_audit_log" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "oauth_tokens" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "emails_raw" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "emails_raw" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "event_locks" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "event_locks" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "feedback" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "error_events" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "error_events" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "model_pricing" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "model_pricing" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "conversation_traces" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_traces" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "conversation_messages" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_messages" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "conversation_parts" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_parts" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "conversation_locks" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_locks" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "action_log" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "action_log" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "approval_policies" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_policies" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint

-- 6. Add foreign key constraints referencing workspaces(id)
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_grants" ADD CONSTRAINT "credential_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_audit_log" ADD CONSTRAINT "credential_audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails_raw" ADD CONSTRAINT "emails_raw_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_locks" ADD CONSTRAINT "event_locks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_traces" ADD CONSTRAINT "conversation_traces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_parts" ADD CONSTRAINT "conversation_parts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_locks" ADD CONSTRAINT "conversation_locks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- 7. Change settings PK from (key) to composite (workspace_id, key)
ALTER TABLE "settings" DROP CONSTRAINT "settings_pkey";--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_workspace_id_key_pk" PRIMARY KEY ("workspace_id", "key");--> statement-breakpoint

-- 7b. Change conversation_locks PK from (channel_id, thread_ts) to (workspace_id, channel_id, thread_ts)
ALTER TABLE "conversation_locks" DROP CONSTRAINT "conversation_locks_pkey";--> statement-breakpoint
ALTER TABLE "conversation_locks" ADD CONSTRAINT "conversation_locks_workspace_id_channel_id_thread_ts_pk" PRIMARY KEY ("workspace_id", "channel_id", "thread_ts");--> statement-breakpoint

-- 8. Drop old unique indexes
DROP INDEX IF EXISTS "notes_topic_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "jobs_name_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "user_profiles_slack_user_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "people_slack_user_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "channels_slack_channel_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "addresses_channel_value_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "emails_raw_user_gmail_msg_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "oauth_tokens_user_provider_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "event_locks_event_ts_channel_id_idx";--> statement-breakpoint
ALTER TABLE "credentials" DROP CONSTRAINT IF EXISTS "credentials_owner_id_name_unique";--> statement-breakpoint
ALTER TABLE "credential_grants" DROP CONSTRAINT IF EXISTS "credential_grants_credential_id_grantee_id_unique";--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_unique_vote";--> statement-breakpoint
ALTER TABLE "model_pricing" DROP CONSTRAINT IF EXISTS "model_pricing_model_token_date_unique";--> statement-breakpoint
ALTER TABLE "action_log" DROP CONSTRAINT IF EXISTS "action_log_idempotency_key_unique";--> statement-breakpoint

-- 9. Create new workspace-scoped composite unique indexes
CREATE UNIQUE INDEX IF NOT EXISTS "notes_workspace_topic_idx" ON "notes" USING btree ("workspace_id", "topic");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_workspace_name_idx" ON "jobs" USING btree ("workspace_id", "name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_profiles_workspace_slack_user_id_idx" ON "user_profiles" USING btree ("workspace_id", "slack_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "people_workspace_slack_user_id_idx" ON "people" USING btree ("workspace_id", "slack_user_id") WHERE slack_user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channels_workspace_slack_channel_id_idx" ON "channels" USING btree ("workspace_id", "slack_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "addresses_workspace_channel_value_idx" ON "addresses" USING btree ("workspace_id", "channel", "value");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "emails_raw_workspace_user_gmail_msg_idx" ON "emails_raw" USING btree ("workspace_id", "user_id", "gmail_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_tokens_workspace_user_provider_idx" ON "oauth_tokens" USING btree ("workspace_id", "user_id", "provider");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_locks_workspace_event_ts_channel_id_idx" ON "event_locks" USING btree ("workspace_id", "event_ts", "channel_id");--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_workspace_owner_id_name_unique" UNIQUE ("workspace_id", "owner_id", "name");--> statement-breakpoint
ALTER TABLE "credential_grants" ADD CONSTRAINT "credential_grants_workspace_credential_id_grantee_id_unique" UNIQUE ("workspace_id", "credential_id", "grantee_id");--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_workspace_unique_vote" UNIQUE ("workspace_id", "message_ts", "channel_id", "user_id");--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_workspace_model_token_date_unique" UNIQUE ("workspace_id", "model_id", "token_type", "effective_from");--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_workspace_idempotency_key_unique" UNIQUE ("workspace_id", "idempotency_key");--> statement-breakpoint

-- 10. Add workspace_id indexes on high-traffic tables for query performance
CREATE INDEX IF NOT EXISTS "messages_workspace_id_idx" ON "messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_workspace_id_idx" ON "memories" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notes_workspace_id_idx" ON "notes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_workspace_id_idx" ON "jobs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_traces_workspace_id_idx" ON "conversation_traces" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_log_workspace_id_idx" ON "action_log" USING btree ("workspace_id");
