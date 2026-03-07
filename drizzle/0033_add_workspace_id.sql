-- Migration: Add workspace_id to all core tables for multi-tenant support.
-- Strategy: add nullable → backfill → set NOT NULL with default → update indexes.

-- ── messages ────────────────────────────────────────────────────────────────
ALTER TABLE "messages" ADD COLUMN "workspace_id" text;
UPDATE "messages" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "messages" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "messages" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
DROP INDEX IF EXISTS "messages_slack_ts_idx";
CREATE UNIQUE INDEX "messages_workspace_slack_ts_idx" ON "messages" ("workspace_id", "slack_ts");
CREATE INDEX "messages_workspace_id_idx" ON "messages" ("workspace_id");

-- ── memories ────────────────────────────────────────────────────────────────
ALTER TABLE "memories" ADD COLUMN "workspace_id" text;
UPDATE "memories" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "memories" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "memories" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
CREATE INDEX "memories_workspace_id_idx" ON "memories" ("workspace_id");

-- ── user_profiles ───────────────────────────────────────────────────────────
ALTER TABLE "user_profiles" ADD COLUMN "workspace_id" text;
UPDATE "user_profiles" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "user_profiles" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "user_profiles" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
DROP INDEX IF EXISTS "user_profiles_slack_user_id_idx";
CREATE UNIQUE INDEX "user_profiles_workspace_slack_user_id_idx" ON "user_profiles" ("workspace_id", "slack_user_id");
CREATE INDEX "user_profiles_workspace_id_idx" ON "user_profiles" ("workspace_id");

-- ── people ──────────────────────────────────────────────────────────────────
ALTER TABLE "people" ADD COLUMN "workspace_id" text;
UPDATE "people" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "people" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "people" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
DROP INDEX IF EXISTS "people_slack_user_id_idx";
CREATE UNIQUE INDEX "people_workspace_slack_user_id_idx" ON "people" ("workspace_id", "slack_user_id") WHERE slack_user_id IS NOT NULL;
CREATE INDEX "people_workspace_id_idx" ON "people" ("workspace_id");

-- ── addresses ───────────────────────────────────────────────────────────────
ALTER TABLE "addresses" ADD COLUMN "workspace_id" text;
UPDATE "addresses" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "addresses" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "addresses" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
DROP INDEX IF EXISTS "addresses_channel_value_idx";
CREATE UNIQUE INDEX "addresses_workspace_channel_value_idx" ON "addresses" ("workspace_id", "channel", "value");
CREATE INDEX "addresses_workspace_id_idx" ON "addresses" ("workspace_id");

-- ── channels ────────────────────────────────────────────────────────────────
ALTER TABLE "channels" ADD COLUMN "workspace_id" text;
UPDATE "channels" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "channels" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "channels" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
DROP INDEX IF EXISTS "channels_slack_channel_id_idx";
CREATE UNIQUE INDEX "channels_workspace_slack_channel_id_idx" ON "channels" ("workspace_id", "slack_channel_id");
CREATE INDEX "channels_workspace_id_idx" ON "channels" ("workspace_id");

-- ── settings (PK change: key → workspace_id + key) ─────────────────────────
ALTER TABLE "settings" ADD COLUMN "workspace_id" text;
UPDATE "settings" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "settings" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "settings" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
ALTER TABLE "settings" DROP CONSTRAINT "settings_pkey";
ALTER TABLE "settings" ADD CONSTRAINT "settings_pkey" PRIMARY KEY ("workspace_id", "key");

-- ── notes ───────────────────────────────────────────────────────────────────
ALTER TABLE "notes" ADD COLUMN "workspace_id" text;
UPDATE "notes" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "notes" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "notes" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
DROP INDEX IF EXISTS "notes_topic_idx";
CREATE UNIQUE INDEX "notes_workspace_topic_idx" ON "notes" ("workspace_id", "topic");
CREATE INDEX "notes_workspace_id_idx" ON "notes" ("workspace_id");

-- ── resources ───────────────────────────────────────────────────────────────
ALTER TABLE "resources" ADD COLUMN "workspace_id" text;
UPDATE "resources" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "resources" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "resources" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
DROP INDEX IF EXISTS "resources_url_idx";
CREATE UNIQUE INDEX "resources_workspace_url_idx" ON "resources" ("workspace_id", "url");
CREATE INDEX "resources_workspace_id_idx" ON "resources" ("workspace_id");

-- ── jobs ────────────────────────────────────────────────────────────────────
ALTER TABLE "jobs" ADD COLUMN "workspace_id" text;
UPDATE "jobs" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "jobs" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "jobs" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
DROP INDEX IF EXISTS "jobs_name_idx";
CREATE UNIQUE INDEX "jobs_workspace_name_idx" ON "jobs" ("workspace_id", "name");
CREATE INDEX "jobs_workspace_id_idx" ON "jobs" ("workspace_id");

-- ── job_executions ──────────────────────────────────────────────────────────
ALTER TABLE "job_executions" ADD COLUMN "workspace_id" text;
UPDATE "job_executions" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "job_executions" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "job_executions" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
CREATE INDEX "job_executions_workspace_id_idx" ON "job_executions" ("workspace_id");

-- ── event_locks ─────────────────────────────────────────────────────────────
ALTER TABLE "event_locks" ADD COLUMN "workspace_id" text;
UPDATE "event_locks" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "event_locks" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "event_locks" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
DROP INDEX IF EXISTS "event_locks_event_ts_channel_id_idx";
CREATE UNIQUE INDEX "event_locks_workspace_event_ts_channel_id_idx" ON "event_locks" ("workspace_id", "event_ts", "channel_id");
CREATE INDEX "event_locks_workspace_id_idx" ON "event_locks" ("workspace_id");

-- ── error_events ────────────────────────────────────────────────────────────
ALTER TABLE "error_events" ADD COLUMN "workspace_id" text;
UPDATE "error_events" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "error_events" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "error_events" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
CREATE INDEX "error_events_workspace_id_idx" ON "error_events" ("workspace_id");

-- ── emails_raw ──────────────────────────────────────────────────────────────
ALTER TABLE "emails_raw" ADD COLUMN "workspace_id" text;
UPDATE "emails_raw" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "emails_raw" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "emails_raw" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
DROP INDEX IF EXISTS "emails_raw_user_gmail_msg_idx";
CREATE UNIQUE INDEX "emails_raw_workspace_user_gmail_msg_idx" ON "emails_raw" ("workspace_id", "user_id", "gmail_message_id");
CREATE INDEX "emails_raw_workspace_id_idx" ON "emails_raw" ("workspace_id");

-- ── oauth_tokens ────────────────────────────────────────────────────────────
ALTER TABLE "oauth_tokens" ADD COLUMN "workspace_id" text;
UPDATE "oauth_tokens" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "oauth_tokens" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "oauth_tokens" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
DROP INDEX IF EXISTS "oauth_tokens_user_provider_idx";
CREATE UNIQUE INDEX "oauth_tokens_workspace_user_provider_idx" ON "oauth_tokens" ("workspace_id", "user_id", "provider");
CREATE INDEX "oauth_tokens_workspace_id_idx" ON "oauth_tokens" ("workspace_id");

-- ── voice_calls ─────────────────────────────────────────────────────────────
ALTER TABLE "voice_calls" ADD COLUMN "workspace_id" text;
UPDATE "voice_calls" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "voice_calls" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "voice_calls" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
ALTER TABLE "voice_calls" DROP CONSTRAINT IF EXISTS "voice_calls_conversation_id_unique";
CREATE UNIQUE INDEX "voice_calls_workspace_conversation_id_idx" ON "voice_calls" ("workspace_id", "conversation_id");
CREATE INDEX "voice_calls_workspace_id_idx" ON "voice_calls" ("workspace_id");

-- ── feedback ────────────────────────────────────────────────────────────────
ALTER TABLE "feedback" ADD COLUMN "workspace_id" text;
UPDATE "feedback" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "feedback" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "feedback" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_unique_vote";
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_workspace_unique_vote" UNIQUE ("workspace_id", "message_ts", "channel_id", "user_id");
CREATE INDEX "feedback_workspace_id_idx" ON "feedback" ("workspace_id");

-- ── credentials ─────────────────────────────────────────────────────────────
ALTER TABLE "credentials" ADD COLUMN "workspace_id" text;
UPDATE "credentials" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "credentials" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "credentials" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
ALTER TABLE "credentials" DROP CONSTRAINT IF EXISTS "credentials_owner_id_name_unique";
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_workspace_owner_id_name_unique" UNIQUE ("workspace_id", "owner_id", "name");
CREATE INDEX "credentials_workspace_id_idx" ON "credentials" ("workspace_id");

-- ── credential_grants ───────────────────────────────────────────────────────
ALTER TABLE "credential_grants" ADD COLUMN "workspace_id" text;
UPDATE "credential_grants" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "credential_grants" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "credential_grants" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
CREATE INDEX "credential_grants_workspace_id_idx" ON "credential_grants" ("workspace_id");

-- ── credential_audit_log ────────────────────────────────────────────────────
ALTER TABLE "credential_audit_log" ADD COLUMN "workspace_id" text;
UPDATE "credential_audit_log" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "credential_audit_log" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "credential_audit_log" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
CREATE INDEX "credential_audit_log_workspace_id_idx" ON "credential_audit_log" ("workspace_id");

-- ── content ─────────────────────────────────────────────────────────────────
ALTER TABLE "content" ADD COLUMN "workspace_id" text;
UPDATE "content" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
ALTER TABLE "content" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "content" ALTER COLUMN "workspace_id" SET DEFAULT 'default';
DROP INDEX IF EXISTS "content_slug_idx";
CREATE UNIQUE INDEX "content_workspace_slug_idx" ON "content" ("workspace_id", "slug");
CREATE INDEX "content_workspace_id_idx" ON "content" ("workspace_id");
