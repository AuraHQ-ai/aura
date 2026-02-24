CREATE TABLE "voice_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"agent_id" text,
	"direction" text DEFAULT 'outbound' NOT NULL,
	"phone_number" text,
	"person_name" text,
	"slack_user_id" text,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"duration_seconds" integer,
	"transcript" jsonb,
	"summary" text,
	"call_context" text,
	"dynamic_variables" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_calls_conversation_id_unique" UNIQUE("conversation_id")
);
--> statement-breakpoint
CREATE INDEX "voice_calls_agent_id_idx" ON "voice_calls" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX "voice_calls_status_idx" ON "voice_calls" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "voice_calls_created_at_idx" ON "voice_calls" USING btree ("created_at");
