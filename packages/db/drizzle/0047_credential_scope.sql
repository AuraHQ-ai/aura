ALTER TABLE "credentials" ADD COLUMN "scope" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_scope_check" CHECK ("credentials"."scope" IN ('member', 'power_user', 'admin', 'owner', 'per_user'));
