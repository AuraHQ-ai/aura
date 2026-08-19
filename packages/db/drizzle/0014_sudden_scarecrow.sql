CREATE TABLE "job_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger" text DEFAULT 'heartbeat' NOT NULL,
	"callback_channel" text,
	"callback_thread_ts" text,
	"steps" jsonb,
	"summary" text,
	"token_usage" jsonb,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_executions_job_id_idx" ON "job_executions" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_executions_started_at_idx" ON "job_executions" USING btree ("started_at");