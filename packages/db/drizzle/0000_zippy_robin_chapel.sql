CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."channel_type" AS ENUM('dm', 'public_channel', 'private_channel');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('fact', 'decision', 'personal', 'relationship', 'sentiment', 'open_thread');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_channel_id" text NOT NULL,
	"name" text NOT NULL,
	"type" "channel_type" NOT NULL,
	"topic" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"type" "memory_type" NOT NULL,
	"source_message_id" uuid,
	"source_channel_type" "channel_type" NOT NULL,
	"related_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"embedding" vector(1536),
	"relevance_score" real DEFAULT 1 NOT NULL,
	"shareable" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_ts" text NOT NULL,
	"slack_thread_ts" text,
	"channel_id" text NOT NULL,
	"channel_type" "channel_type" NOT NULL,
	"user_id" text NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"timezone" text,
	"communication_style" jsonb DEFAULT '{"verbosity":"moderate","formality":"neutral","emojiUsage":"light","preferredFormat":"mixed"}'::jsonb,
	"known_facts" jsonb DEFAULT '{}'::jsonb,
	"interaction_count" integer DEFAULT 0 NOT NULL,
	"last_interaction_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_slack_channel_id_idx" ON "channels" USING btree ("slack_channel_id");--> statement-breakpoint
CREATE INDEX "memories_embedding_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memories_related_users_idx" ON "memories" USING gin ("related_user_ids");--> statement-breakpoint
CREATE INDEX "memories_type_idx" ON "memories" USING btree ("type");--> statement-breakpoint
CREATE INDEX "memories_created_at_idx" ON "memories" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_slack_ts_idx" ON "messages" USING btree ("slack_ts");--> statement-breakpoint
CREATE INDEX "messages_channel_created_idx" ON "messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("slack_thread_ts");--> statement-breakpoint
CREATE UNIQUE INDEX "user_profiles_slack_user_id_idx" ON "user_profiles" USING btree ("slack_user_id");