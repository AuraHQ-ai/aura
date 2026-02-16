-- Step 1: Add new columns to jobs table (IF NOT EXISTS for idempotency)
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "thread_ts" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "execute_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "requested_by" text DEFAULT 'aura' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "result" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_status_execute_idx" ON "jobs" USING btree ("status","execute_at");--> statement-breakpoint

-- Step 2: Migrate pending scheduled_actions into jobs (only if source table still exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scheduled_actions') THEN
    INSERT INTO "jobs" ("name", "description", "execute_at", "channel_id", "thread_ts", "requested_by", "cron_schedule", "timezone", "priority", "status", "last_result", "result", "retries", "created_at", "updated_at")
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
    WHERE "status" = 'pending'
    ON CONFLICT ("name") DO NOTHING;
  END IF;
END $$;--> statement-breakpoint

-- Step 3: Drop the old table
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scheduled_actions') THEN
    ALTER TABLE "scheduled_actions" DISABLE ROW LEVEL SECURITY;
    DROP TABLE "scheduled_actions" CASCADE;
  END IF;
END $$;