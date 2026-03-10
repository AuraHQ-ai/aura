CREATE TABLE "scheduled_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"description" text NOT NULL,
	"execute_at" timestamp with time zone NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text,
	"requested_by" text NOT NULL,
	"recurring" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_result" text,
	"result" text,
	"retries" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "scheduled_actions_status_execute_idx" ON "scheduled_actions" USING btree ("status","execute_at");