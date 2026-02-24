ALTER TABLE "addresses" ALTER COLUMN "person_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "is_discarded" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "discard_reason" text;
