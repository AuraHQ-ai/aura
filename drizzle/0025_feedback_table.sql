CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_ts" text NOT NULL,
	"channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_unique_vote" UNIQUE("message_ts","channel_id","user_id")
);
