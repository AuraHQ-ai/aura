CREATE TYPE "public"."email_triage" AS ENUM('junk', 'fyi', 'actionable', 'urgent');--> statement-breakpoint
CREATE TABLE "emails_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text,
	"cc_address" text,
	"subject" text,
	"snippet" text,
	"body_markdown" text,
	"date" timestamp with time zone,
	"labels" jsonb,
	"is_unread" boolean DEFAULT true,
	"direction" text NOT NULL,
	"triage" "email_triage",
	"embedded" boolean DEFAULT false,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"email" text,
	"refresh_token" text NOT NULL,
	"scopes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "last_profile_consolidation" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "emails_raw_gmail_msg_idx" ON "emails_raw" USING btree ("user_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX "emails_raw_thread_idx" ON "emails_raw" USING btree ("gmail_thread_id");--> statement-breakpoint
CREATE INDEX "emails_raw_user_date_idx" ON "emails_raw" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "emails_raw_triage_idx" ON "emails_raw" USING btree ("triage");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_user_provider_idx" ON "oauth_tokens" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "oauth_tokens_email_idx" ON "oauth_tokens" USING btree ("email");