CREATE TABLE IF NOT EXISTS "emails_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"subject" text,
	"from_email" text,
	"from_name" text,
	"to_emails" text[],
	"cc_emails" text[],
	"date" timestamp with time zone,
	"body_markdown" text,
	"body_raw" text,
	"snippet" text,
	"label_ids" text[],
	"triage_class" text,
	"triage_reason" text,
	"triage_model" text,
	"triaged_at" timestamp with time zone,
	"is_inbound" boolean,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "emails_raw_user_gmail_id_idx" ON "emails_raw" USING btree ("user_id","gmail_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_emails_raw_user_thread" ON "emails_raw" USING btree ("user_id","gmail_thread_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_emails_raw_user_triage" ON "emails_raw" USING btree ("user_id","triage_class");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_emails_raw_date" ON "emails_raw" USING btree ("date" DESC NULLS LAST);
