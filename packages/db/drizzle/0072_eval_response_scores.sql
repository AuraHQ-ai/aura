CREATE TABLE IF NOT EXISTS "eval_response_scores" (
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"message_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"trace_id" uuid NOT NULL,
	"thread_ts" text,
	"serving_intent" text,
	"resolved_in_window" boolean DEFAULT false NOT NULL,
	"verdict" text NOT NULL,
	"scorable" boolean NOT NULL,
	"failure_class" text DEFAULT 'none' NOT NULL,
	"note" text,
	"gold_answer" text,
	"rubric" jsonb,
	"ratified_by" text,
	"judge_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_response_scores_verdict_check" CHECK ("eval_response_scores"."verdict" IN ('fulfilled', 'partial', 'failed')),
	CONSTRAINT "eval_response_scores_failure_class_check" CHECK ("eval_response_scores"."failure_class" IN ('missing_cred', 'bad_memory', 'bad_harness', 'missing_tool', 'reasoning', 'latency', 'none'))
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eval_response_scores" ADD CONSTRAINT "eval_response_scores_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eval_response_scores" ADD CONSTRAINT "eval_response_scores_message_id_conversation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eval_response_scores" ADD CONSTRAINT "eval_response_scores_part_id_conversation_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."conversation_parts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eval_response_scores" ADD CONSTRAINT "eval_response_scores_trace_id_conversation_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."conversation_traces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "eval_response_scores_workspace_part_idx" ON "eval_response_scores" USING btree ("workspace_id","part_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_response_scores_message_idx" ON "eval_response_scores" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_response_scores_trace_idx" ON "eval_response_scores" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_response_scores_thread_idx" ON "eval_response_scores" USING btree ("thread_ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_response_scores_failure_class_idx" ON "eval_response_scores" USING btree ("failure_class");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_response_scores_serving_intent_idx" ON "eval_response_scores" USING btree ("serving_intent");
