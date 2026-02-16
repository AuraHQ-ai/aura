-- Step 1: Add new columns to jobs table first
ALTER TABLE "jobs" ADD COLUMN "thread_ts" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "execute_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "requested_by" text DEFAULT 'aura' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "result" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_status_execute_idx" ON "jobs" USING btree ("status","execute_at");--> statement-breakpoint

-- Step 2: Migrate pending scheduled_actions into jobs before dropping the table
INSERT INTO "jobs" ("name", "description", "execute_at", "channel_id", "thread_ts", "requested_by", "recurring", "timezone", "priority", "status", "last_result", "result", "retries", "created_at", "updated_at")
SELECT
  'action-' || "id",
  "description",
  "execute_at",
  "channel_id",
  "thread_ts",
  "requested_by",
  "recurring",
  "timezone",
  "priority",
  "status",
  "last_result",
  "result",
  "retries",
  "created_at",
  NOW()
FROM "scheduled_actions"
WHERE "status" = 'pending';--> statement-breakpoint

-- Step 3: Drop the old table
ALTER TABLE "scheduled_actions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "scheduled_actions" CASCADE;