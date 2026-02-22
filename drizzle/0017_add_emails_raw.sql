CREATE TABLE "emails_raw" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "gmail_message_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "subject" text,
  "from_address" text,
  "to_addresses" text[],
  "cc_addresses" text[],
  "date" timestamptz,
  "body_markdown" text,
  "body_html" text,
  "labels" text[],
  "size_bytes" integer,
  "is_important" boolean,
  "triage_reason" text,
  "synced_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "emails_raw_user_message_idx" ON "emails_raw" ("user_id", "gmail_message_id");
--> statement-breakpoint
CREATE INDEX "emails_raw_user_date_idx" ON "emails_raw" ("user_id", "date");
--> statement-breakpoint
CREATE INDEX "emails_raw_thread_idx" ON "emails_raw" ("thread_id");
--> statement-breakpoint
CREATE INDEX "emails_raw_user_important_idx" ON "emails_raw" ("user_id", "is_important");
