CREATE TABLE "error_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"error_name" text NOT NULL,
	"error_message" text NOT NULL,
	"error_code" text,
	"user_id" text,
	"channel_id" text,
	"channel_type" text,
	"context" jsonb,
	"stack_trace" text,
	"resolved" boolean DEFAULT false
);
--> statement-breakpoint
CREATE INDEX "error_events_timestamp_idx" ON "error_events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "error_events_error_code_idx" ON "error_events" USING btree ("error_code");