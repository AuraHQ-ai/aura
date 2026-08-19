-- Multi-channel support: allow non-Slack messages to be stored.

-- 1. Add 'dashboard' to channel_type enum
ALTER TYPE channel_type ADD VALUE IF NOT EXISTS 'dashboard';--> statement-breakpoint

-- 2. Add external_id column (channel-agnostic dedup key), backfill from slack_ts
ALTER TABLE "messages" ADD COLUMN "external_id" text;--> statement-breakpoint
UPDATE "messages" SET "external_id" = "slack_ts" WHERE "external_id" IS NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "external_id" SET NOT NULL;--> statement-breakpoint

-- 3. Make slack_ts nullable (only populated for Slack messages)
ALTER TABLE "messages" ALTER COLUMN "slack_ts" DROP NOT NULL;--> statement-breakpoint

-- 4. Replace the old unique index with one on external_id
DROP INDEX IF EXISTS "messages_slack_ts_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_external_id_idx" ON "messages" USING btree ("external_id");--> statement-breakpoint

-- 5. Add source column to conversation_traces
ALTER TABLE "conversation_traces" ADD COLUMN "source" text NOT NULL DEFAULT 'slack';
