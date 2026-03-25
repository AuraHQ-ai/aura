ALTER TABLE "credentials" ADD COLUMN "scope" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_scope_check" CHECK ("credentials"."scope" IN ('shared', 'admin_only', 'per_user'));
