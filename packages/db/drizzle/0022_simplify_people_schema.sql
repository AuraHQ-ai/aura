ALTER TABLE "people" ADD COLUMN "slack_user_id" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "job_title" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "gender" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "preferred_language" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "birthdate" date;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "manager_id" uuid;--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "addresses" DROP COLUMN "confidence";--> statement-breakpoint
ALTER TABLE "addresses" DROP COLUMN "source";--> statement-breakpoint
ALTER TABLE "addresses" DROP COLUMN "verified_at";--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_manager_id_people_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "people_slack_user_id_idx" ON "people" USING btree ("slack_user_id") WHERE slack_user_id IS NOT NULL;
