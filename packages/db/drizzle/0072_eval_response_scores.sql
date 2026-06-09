-- Eval funnel (Machine A): one atomic verdict per assistant response.
-- Single table, no thread-level verdict table; thread_ts has NO FK.
DO $$ BEGIN
 CREATE TYPE "public"."eval_verdict" AS ENUM('fulfilled', 'partial', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."eval_failure_class" AS ENUM('missing_cred', 'bad_memory', 'bad_harness', 'missing_tool', 'reasoning', 'latency', 'none');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eval_response_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" text NOT NULL DEFAULT 'default' REFERENCES "workspaces"("id"),
  "message_id" uuid NOT NULL REFERENCES "conversation_messages"("id") ON DELETE cascade,
  "part_id" uuid REFERENCES "conversation_parts"("id") ON DELETE cascade,
  "trace_id" uuid REFERENCES "conversation_traces"("id") ON DELETE cascade,
  "thread_ts" text,
  "serving_intent" text,
  "resolved_in_window" boolean,
  "verdict" "eval_verdict",
  "scorable" boolean NOT NULL DEFAULT false,
  "failure_class" "eval_failure_class" NOT NULL DEFAULT 'none',
  "note" text,
  "gold_answer" text,
  "rubric" jsonb,
  "ratified_by" text,
  "judge_model" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "eval_response_scores_workspace_message_idx" ON "eval_response_scores" ("workspace_id", "message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_response_scores_verdict_idx" ON "eval_response_scores" ("workspace_id", "verdict");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_response_scores_failure_class_idx" ON "eval_response_scores" ("workspace_id", "failure_class");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_response_scores_thread_ts_idx" ON "eval_response_scores" ("thread_ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_response_scores_trace_idx" ON "eval_response_scores" ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_response_scores_ratified_idx" ON "eval_response_scores" ("ratified_by") WHERE ratified_by IS NOT NULL;
