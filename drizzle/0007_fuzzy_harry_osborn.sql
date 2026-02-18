CREATE TABLE "event_locks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_ts" text NOT NULL,
	"channel_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "event_locks_event_ts_channel_id_idx" ON "event_locks" USING btree ("event_ts","channel_id");