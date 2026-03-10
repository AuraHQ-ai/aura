CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"playbook" text,
	"cron_schedule" text,
	"frequency_config" jsonb,
	"channel_id" text,
	"last_executed_at" timestamp with time zone,
	"last_result" text,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "category" text DEFAULT 'knowledge' NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_name_idx" ON "jobs" USING btree ("name");--> statement-breakpoint
CREATE INDEX "jobs_enabled_idx" ON "jobs" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "notes_category_idx" ON "notes" USING btree ("category");