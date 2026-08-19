-- Step 1: Create the new generalized conversation tables

CREATE TABLE "conversation_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"job_execution_id" uuid,
	"channel_id" text,
	"thread_ts" text,
	"user_id" text,
	"model_id" text,
	"token_usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ct_source_type_check" CHECK ("conversation_traces"."source_type" IN ('job_execution', 'interactive'))
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text,
	"order_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cm_role_check" CHECK ("conversation_messages"."role" IN ('system', 'user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "conversation_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"type" text NOT NULL,
	"order_index" integer NOT NULL,
	"text_value" text,
	"tool_call_id" text,
	"tool_name" text,
	"tool_input" jsonb,
	"tool_output" jsonb,
	"tool_state" text,
	CONSTRAINT "cp_type_check" CHECK ("conversation_parts"."type" IN ('text', 'reasoning', 'tool-invocation', 'source', 'file', 'step-start', 'error'))
);
--> statement-breakpoint
ALTER TABLE "conversation_traces" ADD CONSTRAINT "conversation_traces_job_execution_id_job_executions_id_fk" FOREIGN KEY ("job_execution_id") REFERENCES "public"."job_executions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversation_traces_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation_traces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_parts" ADD CONSTRAINT "conversation_parts_message_id_conversation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_ct_job_execution" ON "conversation_traces" USING btree ("job_execution_id");
--> statement-breakpoint
CREATE INDEX "idx_ct_channel_thread" ON "conversation_traces" USING btree ("channel_id","thread_ts");
--> statement-breakpoint
CREATE INDEX "idx_ct_created_at" ON "conversation_traces" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "idx_cm_conversation" ON "conversation_messages" USING btree ("conversation_id","order_index");
--> statement-breakpoint
CREATE INDEX "idx_cp_message" ON "conversation_parts" USING btree ("message_id","order_index");
--> statement-breakpoint

-- Step 2: Migrate existing data from job_execution_messages/parts into new tables

INSERT INTO "conversation_traces" ("id", "source_type", "job_execution_id", "created_at")
SELECT DISTINCT
  gen_random_uuid(),
  'job_execution',
  jem."execution_id",
  MIN(jem."created_at")
FROM "job_execution_messages" jem
GROUP BY jem."execution_id";
--> statement-breakpoint

INSERT INTO "conversation_messages" ("id", "conversation_id", "role", "order_index", "created_at")
SELECT
  jem."id",
  ct."id",
  jem."role",
  jem."order_index",
  jem."created_at"
FROM "job_execution_messages" jem
JOIN "conversation_traces" ct ON ct."job_execution_id" = jem."execution_id";
--> statement-breakpoint

INSERT INTO "conversation_parts" ("id", "message_id", "type", "order_index", "text_value", "tool_call_id", "tool_name", "tool_input", "tool_output", "tool_state")
SELECT
  jep."id",
  jep."message_id",
  jep."type",
  jep."order_index",
  jep."text_value",
  jep."tool_call_id",
  jep."tool_name",
  jep."tool_input",
  jep."tool_output",
  jep."tool_state"
FROM "job_execution_parts" jep
WHERE EXISTS (SELECT 1 FROM "conversation_messages" cm WHERE cm."id" = jep."message_id");
--> statement-breakpoint

-- Step 3: Drop the old tables

DROP TABLE "job_execution_parts";
--> statement-breakpoint
DROP TABLE "job_execution_messages";
