ALTER TABLE "memories" ADD COLUMN "source_thread_ts" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_channel_id" text;--> statement-breakpoint
CREATE INDEX "memories_source_channel_id_idx" ON "memories" USING btree ("source_channel_id");
