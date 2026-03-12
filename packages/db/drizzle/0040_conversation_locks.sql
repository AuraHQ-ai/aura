CREATE TABLE IF NOT EXISTS "conversation_locks" (
  "channel_id" TEXT NOT NULL,
  "thread_ts" TEXT NOT NULL,
  "invocation_id" TEXT NOT NULL,
  "message_ts" TEXT NOT NULL,
  "started_at" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  PRIMARY KEY ("channel_id", "thread_ts")
);
-->statement-breakpoint
ALTER TABLE "conversation_locks" ADD COLUMN IF NOT EXISTS "message_ts" TEXT;
-->statement-breakpoint
UPDATE "conversation_locks" SET "message_ts" = '0' WHERE "message_ts" IS NULL;
-->statement-breakpoint
ALTER TABLE "conversation_locks" ALTER COLUMN "message_ts" SET NOT NULL;
