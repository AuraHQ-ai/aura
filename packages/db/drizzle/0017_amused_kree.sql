CREATE TABLE IF NOT EXISTS "emails_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"subject" text,
	"from_email" text NOT NULL,
	"from_name" text,
	"to_emails" jsonb,
	"cc_emails" jsonb,
	"date" timestamp with time zone NOT NULL,
	"body_markdown" text,
	"body_size_bytes" integer,
	"triage" text,
	"triage_reason" text,
	"direction" text NOT NULL,
	"has_attachments" boolean DEFAULT false,
	"labels" jsonb,
	"raw_headers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "emails_raw_user_gmail_msg_idx" ON "emails_raw" USING btree ("user_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "emails_raw_user_thread_idx" ON "emails_raw" USING btree ("user_id","gmail_thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "emails_raw_user_triage_idx" ON "emails_raw" USING btree ("user_id","triage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "emails_raw_user_date_idx" ON "emails_raw" USING btree ("user_id","date");
