ALTER TABLE "detached_commands" ADD COLUMN IF NOT EXISTS "job_id" uuid;--> statement-breakpoint
ALTER TABLE "detached_commands" ADD COLUMN IF NOT EXISTS "job_execution_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "detached_commands" ADD CONSTRAINT "detached_commands_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "detached_commands" ADD CONSTRAINT "detached_commands_job_execution_id_job_executions_id_fk" FOREIGN KEY ("job_execution_id") REFERENCES "public"."job_executions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
