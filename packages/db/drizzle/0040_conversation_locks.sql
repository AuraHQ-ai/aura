CREATE TABLE IF NOT EXISTS "conversation_locks" (
  "channel_id" TEXT NOT NULL,
  "thread_ts" TEXT NOT NULL,
  "invocation_id" TEXT NOT NULL,
  "message_ts" TEXT NOT NULL,
  "started_at" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  PRIMARY KEY ("channel_id", "thread_ts")
);
