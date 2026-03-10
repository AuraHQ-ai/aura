ALTER TABLE "emails_raw" ADD COLUMN "thread_state" text;--> statement-breakpoint
ALTER TABLE "emails_raw" ADD COLUMN "thread_state_reason" text;--> statement-breakpoint
ALTER TABLE "emails_raw" ADD COLUMN "thread_state_updated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "emails_raw_user_thread_state_idx" ON "emails_raw" USING btree ("user_id","thread_state");
