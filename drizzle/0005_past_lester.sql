ALTER TABLE "jobs" ADD COLUMN "today_executions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "last_execution_date" text;