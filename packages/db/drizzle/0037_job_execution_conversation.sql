CREATE TABLE "job_execution_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_index" integer NOT NULL,
	CONSTRAINT "jem_role_check" CHECK ("job_execution_messages"."role" IN ('system', 'user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "job_execution_parts" (
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
	CONSTRAINT "jep_type_check" CHECK ("job_execution_parts"."type" IN ('text', 'reasoning', 'tool-invocation', 'source', 'file', 'step-start', 'error'))
);
--> statement-breakpoint
ALTER TABLE "job_execution_messages" ADD CONSTRAINT "job_execution_messages_execution_id_job_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."job_executions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "job_execution_parts" ADD CONSTRAINT "job_execution_parts_message_id_job_execution_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."job_execution_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_jem_execution" ON "job_execution_messages" USING btree ("execution_id","order_index");
--> statement-breakpoint
CREATE INDEX "idx_jep_message" ON "job_execution_parts" USING btree ("message_id","order_index");
