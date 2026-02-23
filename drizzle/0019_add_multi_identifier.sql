ALTER TABLE "user_profiles" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "source" text NOT NULL DEFAULT 'slack';--> statement-breakpoint
ALTER TABLE "user_profiles" ALTER COLUMN "slack_user_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "user_profiles_slack_user_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "user_profiles_slack_user_id_idx" ON "user_profiles" USING btree ("slack_user_id") WHERE slack_user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_profiles_email_idx" ON "user_profiles" USING btree ("email") WHERE email IS NOT NULL;--> statement-breakpoint
UPDATE "user_profiles" SET "source" = 'slack' WHERE "source" IS NULL;
