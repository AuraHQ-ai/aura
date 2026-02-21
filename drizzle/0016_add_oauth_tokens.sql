CREATE TABLE IF NOT EXISTS "oauth_tokens" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_tokens_user_provider_idx" ON "oauth_tokens" USING btree ("user_id","provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_tokens_email_idx" ON "oauth_tokens" USING btree ("email");
